// Pure decisions for the store-build command: which secrets a local build lacks, whether a pinned Xcode image rules
// out a local iOS build, which App Groups the EAS provisioning profiles lack, and where the build may run.
// src/commands/store-build-cli.ts does the I/O.

export type Platform = "ios" | "android";

export const ARCHIVE_EXTENSION: Record<Platform, string> = { ios: "ipa", android: "aab" };

export const MIN_FREE_GB = 20;

export interface EasVariable {
  name: string;
  visibility: string;
}

// Reads `eas env:list <environment> --format long`, which prints one `Name` and one `Visibility` line per variable.
export function parseEasVariables(output: string): EasVariable[] {
  const variables: EasVariable[] = [];

  for (const line of output.split("\n")) {
    const match = line.match(/^(Name|Visibility)\s+(\S+)/);

    if (match?.[1] === "Name") {
      variables.push({ name: match[2], visibility: "" });
    } else if (match?.[1] === "Visibility" && variables.length) {
      variables[variables.length - 1].visibility = match[2].toUpperCase();
    }
  }

  return variables;
}

// EAS never hands variables with secret visibility to a local build, so this Mac must supply them. A value that is an
// absolute path, such as an untracked Firebase file, must point at a file that exists.
export function missingSecrets(
  variables: EasVariable[],
  env: Record<string, string | undefined>,
  options: { allowMissing: string[]; hasSentryLogin: boolean; fileExists: (path: string) => boolean },
): string[] {
  const missing: string[] = [];

  for (const { name, visibility } of variables) {
    if (visibility !== "SECRET" || options.allowMissing.includes(name)) {
      continue;
    }

    const value = env[name];

    if (!value) {
      // Sentry's upload also reads the token that `sentry-cli login` saves.
      if (name === "SENTRY_AUTH_TOKEN" && options.hasSentryLogin) {
        continue;
      }

      missing.push(name);
    } else if (value.startsWith("/") && !options.fileExists(value)) {
      missing.push(`${name} (no file at ${value})`);
    }
  }

  return missing;
}

// Builds against a newer iOS SDK major can change app lifecycle requirements, so a project pinned to an older Xcode
// image builds iOS in the cloud until it removes the pin.
export function xcodePinBlocksLocal(image: string | undefined, localXcode: string): boolean {
  const pinned = image?.match(/xcode-(\d+)/)?.[1];
  const local = localXcode.match(/Xcode (\d+)/)?.[1];

  return Boolean(pinned && local && Number(pinned) < Number(local));
}

// A local build's shell overrides the EAS environment, so a development URL or analytics flag exported in the shell
// would reach the store build; every EXPO_PUBLIC_ variable must come from EAS.
export function storeBuildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("EXPO_PUBLIC_")));
}

type Entitlements = Record<string, unknown>;

interface AppExtension {
  targetName: string;
  bundleIdentifier: string;
  entitlements?: Entitlements;
}

// The part of `expo config --json --type introspect` that EAS reads to sign a project that generates its native
// folders: the app's bundle identifier and entitlements after config plugins run, and the extensions plugins declare.
export interface IntrospectedConfig {
  name?: string;
  ios?: { bundleIdentifier?: string; entitlements?: Entitlements };
  extra?: { eas?: { projectId?: string; build?: { experimental?: { ios?: { appExtensions?: AppExtension[] } } } } };
}

export interface SigningTarget {
  name: string;
  bundleIdentifier: string;
  appGroups: string[];
}

function appGroups(entitlements: Entitlements | undefined): string[] {
  const groups = entitlements?.["com.apple.security.application-groups"];

  return Array.isArray(groups) ? groups.filter((group) => typeof group === "string") : [];
}

// EAS signs the app and each extension listed under extra.eas.build.experimental.ios.appExtensions, each with its own
// provisioning profile.
export function signingTargets(config: IntrospectedConfig): SigningTarget[] {
  const extensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];

  return [
    {
      name: config.name ?? "app",
      bundleIdentifier: config.ios?.bundleIdentifier ?? "",
      appGroups: appGroups(config.ios?.entitlements),
    },
    ...extensions.map((extension) => ({
      name: extension.targetName,
      bundleIdentifier: extension.bundleIdentifier,
      appGroups: appGroups(extension.entitlements),
    })),
  ];
}

// The App Store build credentials EAS stores for each bundle identifier of a project. A store build gets these
// profiles as stored, even after the App ID gains a capability.
export const EAS_IOS_PROFILES_QUERY = `
  query StoreBuildIosProfiles($projectId: String!) {
    app {
      byId(appId: $projectId) {
        iosAppCredentials {
          appleAppIdentifier { bundleIdentifier }
          iosAppBuildCredentialsList(filter: { iosDistributionType: APP_STORE }) {
            provisioningProfile { provisioningProfile }
          }
        }
      }
    }
  }
`;

interface IosAppCredentials {
  appleAppIdentifier: { bundleIdentifier: string };
  iosAppBuildCredentialsList: { provisioningProfile: { provisioningProfile: string | null } | null }[];
}

export interface EasIosProfilesResponse {
  data?: { app?: { byId?: { iosAppCredentials: IosAppCredentials[] } | null } };
  errors?: { message: string }[];
}

// Maps each bundle identifier to its stored profile, base64-encoded; like eas-cli, takes the first credentials found.
export function easProfiles(response: EasIosProfilesResponse): Map<string, string> {
  const profiles = new Map<string, string>();

  for (const credentials of response.data?.app?.byId?.iosAppCredentials ?? []) {
    const profile = credentials.iosAppBuildCredentialsList[0]?.provisioningProfile?.provisioningProfile;
    const { bundleIdentifier } = credentials.appleAppIdentifier;

    if (profile && !profiles.has(bundleIdentifier)) {
      profiles.set(bundleIdentifier, profile);
    }
  }

  return profiles;
}

// A provisioning profile is a signed plist whose Entitlements dictionary lists the App Groups it grants; an empty
// `<array/>` grants none.
export function profileAppGroups(profileBase64: string): string[] {
  const plist = Buffer.from(profileBase64, "base64").toString("latin1");
  const list = plist.match(/<key>com\.apple\.security\.application-groups<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];

  return [...(list ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
}

// Xcode refuses to sign a target whose profile lacks an App Group its entitlements configure, but only after the
// dependencies install and the build starts. Enabling App Groups on an App ID does not update the profile EAS stores,
// so an active profile can still have an empty group list. Returns one line per target that would fail.
export function appGroupGaps(targets: SigningTarget[], profiles: Map<string, string>): string[] {
  const gaps: string[] = [];

  for (const target of targets) {
    if (!target.appGroups.length) {
      continue;
    }

    const label = `${target.name} (${target.bundleIdentifier})`;
    const profile = profiles.get(target.bundleIdentifier);

    if (!profile) {
      gaps.push(`${label} has no App Store provisioning profile on EAS`);
      continue;
    }

    const granted = profileAppGroups(profile);
    const missing = target.appGroups.filter((group) => !granted.includes(group));

    if (missing.length) {
      gaps.push(`${label} lacks ${missing.join(", ")}`);
    }
  }

  return gaps;
}

// Linking an App Group to an App ID needs an Apple ID session, which only the interactive credentials flow opens.
export function appGroupRepair(gaps: string[], buildProfile: string): string {
  return [
    "The EAS provisioning profiles lack App Groups that the targets' entitlements configure, so signing would fail:",
    ...gaps.map((gap) => `- ${gap}`),
    `Repair them from this folder: run the command below, choose the "${buildProfile}" build profile, then ` +
      "Build Credentials → All, and sign in to Apple so EAS links the groups and regenerates the profiles.",
    "eas credentials --platform ios",
  ].join("\n");
}
