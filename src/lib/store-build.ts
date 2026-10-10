// Pure decisions for the store-build command: which secrets a local build lacks, whether a pinned Xcode image rules
// out a local iOS build, and where the build may run. src/commands/store-build-cli.ts does the I/O.

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
