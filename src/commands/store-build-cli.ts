#!/usr/bin/env bun

// Builds a store app on this Mac with `eas build --local`, then uploads it with `eas submit`, so a store build spends
// no EAS cloud build. Run it from the app folder that holds eas.json. The mobile-app-infra skill documents when to use it.

import { agentOutput, parseCli } from "../lib/agent-output";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cac } from "cac";

import {
  ARCHIVE_EXTENSION,
  EAS_IOS_PROFILES_QUERY,
  type EasIosProfilesResponse,
  type IntrospectedConfig,
  MIN_FREE_GB,
  type Platform,
  appGroupGaps,
  appGroupRepair,
  easProfiles,
  missingSecrets,
  parseEasVariables,
  signingTargets,
  storeBuildEnv,
  xcodePinBlocksLocal,
} from "../lib/store-build";

const EXTERNAL_DISK = "/Volumes/DevSSD";

interface BuildProfile {
  extends?: string;
  environment?: string;
  credentialsSource?: string;
  ios?: { image?: string; credentialsSource?: string };
}

interface EasJson {
  build?: Record<string, BuildProfile>;
  submit?: Record<string, unknown>;
}

interface ExpoState {
  auth?: { sessionSecret?: string };
}

interface Options {
  profile: string;
  cloud?: boolean;
  dryRun?: boolean;
  allowMissing?: string;
}

// Thrown instead of exiting, so a failed build still cleans up its working folder.
class Stop extends Error {}

function fail(message: string): never {
  throw new Stop(message);
}

function run(command: string[], env: NodeJS.ProcessEnv, dryRun = false): boolean {
  console.log(`\n$ ${command.join(" ")}`);

  return dryRun || spawnSync(command[0], command.slice(1), { env, stdio: "inherit" }).status === 0;
}

function capture(
  command: string[],
  env = process.env,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", env });

  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function profileValue<T>(
  eas: EasJson,
  name: string,
  read: (profile: BuildProfile) => T | undefined,
): T | undefined {
  const profile = eas.build?.[name];

  return (
    profile &&
    (read(profile) ?? (profile.extends ? profileValue(eas, profile.extends, read) : undefined))
  );
}

// A folder under /Volumes stays behind when its disk is unmounted, so only a separate device counts as mounted.
function isMounted(path: string): boolean {
  return existsSync(path) && statSync(path).dev !== statSync(dirname(path)).dev;
}

// A build needs about 20 GB, more than the internal disk keeps free.
function buildRoot(): string {
  const root =
    process.env.EAS_LOCAL_BUILD_ROOT ||
    (isMounted(EXTERNAL_DISK) ? join(EXTERNAL_DISK, "eas-builds") : undefined);

  if (!root) {
    fail(
      `${EXTERNAL_DISK} is not mounted. Mount it, or set EAS_LOCAL_BUILD_ROOT to a folder with ${MIN_FREE_GB} GB free.`,
    );
  }

  mkdirSync(root, { recursive: true });
  const { bavail, bsize } = statfsSync(root);
  const freeGb = (bavail * bsize) / 1024 ** 3;

  if (freeGb < MIN_FREE_GB) {
    fail(`${root} has ${freeGb.toFixed(1)} GB free; a local build needs ${MIN_FREE_GB} GB.`);
  }

  return root;
}

function checkSecrets(environment: string, allowMissing: string[]): void {
  const listing = capture(["eas", "env:list", environment, "--format", "long"]);

  if (!listing.ok) {
    fail(
      `Could not list the EAS "${environment}" variables. Check eas login, and that the app's dependencies are installed:\n` +
        listing.stderr.trim(),
    );
  }

  const sentryLogin = join(homedir(), ".sentryclirc");
  const missing = missingSecrets(parseEasVariables(listing.stdout), process.env, {
    allowMissing,
    hasSentryLogin:
      existsSync(sentryLogin) && /^\s*token\s*=\s*\S/m.test(readFileSync(sentryLogin, "utf8")),
    fileExists: existsSync,
  });

  if (missing.length) {
    fail(
      `EAS keeps secret variables from local builds; set these first: ${missing.join(", ")}.\n` +
        "Pass --allow-missing <names> for a secret the build does not use.",
    );
  }
}

// eas-cli signs in with EXPO_TOKEN, or else with the session `eas login` saves.
function easAuthHeaders(): Record<string, string> {
  if (process.env.EXPO_TOKEN) {
    return { authorization: `Bearer ${process.env.EXPO_TOKEN}` };
  }

  const state = join(homedir(), ".expo", "state.json");
  const session = existsSync(state)
    ? (JSON.parse(readFileSync(state, "utf8")) as ExpoState).auth?.sessionSecret
    : "";

  if (!session) {
    fail("Run eas login, or set EXPO_TOKEN, so store-build can read the EAS iOS credentials.");
  }

  return { "expo-session": session };
}

async function readEasProfiles(projectId: string): Promise<Map<string, string>> {
  const headers = { "content-type": "application/json", ...easAuthHeaders() };
  const body = JSON.stringify({ query: EAS_IOS_PROFILES_QUERY, variables: { projectId } });
  let response: EasIosProfilesResponse;

  try {
    const request = await fetch("https://api.expo.dev/graphql", { method: "POST", headers, body });
    response = (await request.json()) as EasIosProfilesResponse;
  } catch (error) {
    fail(`Could not read the EAS iOS credentials: ${(error as Error).message}`);
  }

  if (!response.data?.app?.byId) {
    const reason =
      response.errors?.map((error) => error.message).join("; ") ?? "the response has no project";
    fail(`Could not read the EAS iOS credentials of project ${projectId}: ${reason}`);
  }

  return easProfiles(response);
}

// Runs before a cloud build too, because EAS hands it the same stored profiles. A project that keeps its own profiles
// in credentials.json signs with those, and EAS assigns none.
async function checkAppGroups(eas: EasJson, buildProfile: string): Promise<void> {
  const source = profileValue(
    eas,
    buildProfile,
    (profile) => profile.ios?.credentialsSource ?? profile.credentialsSource,
  );

  if (source === "local") {
    return;
  }

  // The introspection eas-cli runs to read the entitlements it signs with.
  const env = { ...storeBuildEnv(process.env), EXPO_NO_DOTENV: "1" };
  const introspection = capture(["bunx", "expo", "config", "--json", "--type", "introspect"], env);

  if (!introspection.ok) {
    fail(`Could not read the app config with expo config:\n${introspection.stderr.trim()}`);
  }

  const config = JSON.parse(introspection.stdout) as IntrospectedConfig;
  const targets = signingTargets(config).filter((target) => target.appGroups.length);
  const projectId = config.extra?.eas?.projectId;

  if (!targets.length) {
    return;
  }

  if (!projectId) {
    fail(
      "The app config has no extra.eas.projectId, so store-build cannot find its EAS credentials.",
    );
  }

  const gaps = appGroupGaps(targets, await readEasProfiles(projectId));

  if (gaps.length) {
    fail(appGroupRepair(gaps, buildProfile));
  }
}

function buildInCloud(platform: Platform, submitProfile: string, options: Options): void {
  const command = ["eas", "build", "--platform", platform, "--profile", options.profile];

  if (
    !run(
      [...command, "--auto-submit-with-profile", submitProfile, "--non-interactive"],
      process.env,
      options.dryRun,
    )
  ) {
    fail("The EAS build or its submission failed; see the build on expo.dev.");
  }
}

function buildLocally(
  appDir: string,
  platform: Platform,
  submitProfile: string,
  eas: EasJson,
  options: Options,
): void {
  const env = storeBuildEnv(process.env);

  if (platform === "ios") {
    const image = profileValue(eas, options.profile, (profile) => profile.ios?.image);

    if (xcodePinBlocksLocal(image, capture(["xcodebuild", "-version"]).stdout)) {
      fail(
        `eas.json pins the ${image} build image, older than this Mac's Xcode. Rerun with --cloud to build iOS on EAS ` +
          "until the project moves the pin to this Xcode or removes it.",
      );
    }
  } else {
    env.ANDROID_HOME ||= join(homedir(), "Library", "Android", "sdk");

    if (!existsSync(env.ANDROID_HOME)) {
      fail(`No Android SDK at ${env.ANDROID_HOME}. Install it, or set ANDROID_HOME.`);
    }
  }

  const environment =
    profileValue(eas, options.profile, (profile) => profile.environment) ?? options.profile;
  checkSecrets(environment, options.allowMissing?.split(",").filter(Boolean) ?? []);

  const root = buildRoot();
  const runDir = join(
    root,
    `${basename(appDir)}-${platform}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const archive = join(runDir, `${basename(appDir)}.${ARCHIVE_EXTENSION[platform]}`);
  // Temporary files and the Xcode archive stay on the build disk and go with the run.
  env.EAS_LOCAL_BUILD_WORKINGDIR = join(runDir, "work");
  env.TMPDIR = join(runDir, "tmp");
  env.GYM_BUILD_PATH = join(runDir, "xcode-archive");

  const build = [
    "eas",
    "build",
    "--local",
    "--platform",
    platform,
    "--profile",
    options.profile,
    "--non-interactive",
  ];
  const submit = [
    "eas",
    "submit",
    "--platform",
    platform,
    "--profile",
    submitProfile,
    "--path",
    archive,
    "--non-interactive",
  ];

  if (options.dryRun) {
    run([...build, "--output", archive], env, true);
    run(submit, env, true);

    return;
  }

  mkdirSync(env.TMPDIR, { recursive: true });
  let submitted = false;

  try {
    if (!run([...build, "--output", archive], env)) {
      fail("The local build failed; nothing was submitted.");
    }

    submitted = run(submit, env);

    if (!submitted) {
      fail(
        `The submission failed. The build is kept at ${archive}; retry from ${appDir} with:\n${submit.join(" ")}`,
      );
    }
  } finally {
    rmSync(env.EAS_LOCAL_BUILD_WORKINGDIR, { recursive: true, force: true });
    rmSync(env.TMPDIR, { recursive: true, force: true });
    rmSync(env.GYM_BUILD_PATH, { recursive: true, force: true });

    // A built archive whose submission failed stays, so it can be resubmitted without another build.
    if (submitted || !existsSync(archive)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
}

async function storeBuild(
  platform: string,
  submitProfile: string,
  options: Options,
): Promise<void> {
  const appDir = process.cwd();
  const easPath = join(appDir, "eas.json");

  if (!existsSync(easPath)) {
    fail("No eas.json here; run store-build from the app folder.");
  }

  const eas = JSON.parse(readFileSync(easPath, "utf8")) as EasJson;
  const submitProfiles = Object.keys(eas.submit ?? {}).join(", ");

  if (platform !== "ios" && platform !== "android") {
    fail("The platform must be ios or android.");
  }

  if (!eas.submit?.[submitProfile]) {
    fail(`eas.json has no submit profile "${submitProfile}". Submit profiles: ${submitProfiles}.`);
  }

  if (!eas.build?.[options.profile]) {
    fail(`eas.json has no build profile "${options.profile}".`);
  }

  if (platform === "ios") {
    await checkAppGroups(eas, options.profile);
  }

  if (options.cloud) {
    buildInCloud(platform, submitProfile, options);
  } else {
    buildLocally(appDir, platform, submitProfile, eas, options);
  }
}

agentOutput("store-build", { nativeJson: false });

const cli = cac("store-build");

cli
  .command(
    "<platform> <submit-profile>",
    "Build ios or android on this Mac, then upload it with the named eas.json submit profile",
  )
  .option("--profile <name>", "EAS build profile", { default: "production" })
  .option("--cloud", "Build on EAS instead, and submit when the build finishes")
  .option("--allow-missing <names>", "Comma-separated secret EAS variables the build does not use")
  .option(
    "--dry-run",
    "Run the checks and print the build and submit commands without running them",
  )
  .action(async (platform: string, submitProfile: string, options: Options) => {
    try {
      await storeBuild(platform, submitProfile, options);
    } catch (error) {
      if (!(error instanceof Stop)) {
        throw error;
      }

      console.error(`\nstore-build: ${error.message}`);
      process.exit(1);
    }
  });

cli.option("--json", "Emit structured results");
cli.option("--verbose", "Print details");
cli.help();
parseCli(cli);
