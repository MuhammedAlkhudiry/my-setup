#!/usr/bin/env bun

import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Platform = "android" | "ios" | "all";

type StatusSection = {
  status: "ok" | "missing" | "error" | "skipped";
  details: Record<string, unknown>;
};

type ExpoConfig = {
  expo?: {
    version?: string;
    android?: {
      package?: string;
    };
    ios?: {
      bundleIdentifier?: string;
    };
  };
};

type EasConfig = {
  cli?: {
    appVersionSource?: string;
  };
  submit?: {
    production?: {
      android?: {
        track?: string;
        releaseStatus?: string;
      };
      ios?: {
        ascAppId?: string;
      };
    };
  };
};

const args = parseArgs(process.argv.slice(2));
const projectRoot = resolve(requiredArg(args, "project-root"));
const mobileDir = resolve(projectRoot, requiredArg(args, "mobile-dir"));
const localOnly = args.has("local-only");
const jsonOutput = args.has("json");
const platform = getPlatform(args.get("platform") ?? "all");

const report: Record<string, StatusSection> = {};

for (const envPath of args.getAll("env")) {
  loadEnvFile(resolvePath(envPath));
}

loadEnvFile(resolve(mobileDir, ".env.release"));

const appJson = readJson<ExpoConfig>(resolve(mobileDir, "app.json"));
const easJson = readJson<EasConfig>(resolve(mobileDir, "eas.json"));

const expo = appJson.expo ?? {};
const releaseVersion = args.get("release-version") ?? expo.version;
const androidPackage = args.get("android-package") ?? expo.android?.package;
const iosBundleId = args.get("ios-bundle-id") ?? expo.ios?.bundleIdentifier;
const googleTrack =
  args.get("google-track") ?? easJson.submit?.production?.android?.track ?? "production";
const ascAppId = args.get("asc-app-id") ?? easJson.submit?.production?.ios?.ascAppId;

report.local = {
  status: "ok",
  details: {
    projectRoot,
    mobileDir,
    releaseVersion,
    androidPackage,
    iosBundleId,
    ascAppId,
    googleTrack,
    easAppVersionSource: easJson.cli?.appVersionSource,
    androidSubmit: easJson.submit?.production?.android ?? null,
    iosSubmit: easJson.submit?.production?.ios ?? null,
  },
};

if (localOnly) {
  report.eas = skipped("Skipped by --local-only");
  report.googlePlay = skipped("Skipped by --local-only");
  report.appStoreConnect = skipped("Skipped by --local-only");
  finish();
  process.exit(0);
}

report.eas = getEasStatus();

if (platform === "android" || platform === "all") {
  report.googlePlay = await getGooglePlayStatus(androidPackage, googleTrack);
} else {
  report.googlePlay = skipped("Skipped because --platform is ios");
}

if (platform === "ios" || platform === "all") {
  report.appStoreConnect = await getAppStoreStatus(ascAppId, releaseVersion);
} else {
  report.appStoreConnect = skipped("Skipped because --platform is android");
}

finish();

function getEasStatus(): StatusSection {
  const easCliPackage = getEasCliPackage();
  const whoami = run(["bunx", easCliPackage, "whoami", "--non-interactive"]);
  const builds = run([
    "bunx",
    easCliPackage,
    "build:list",
    "--limit",
    "4",
    "--json",
    "--non-interactive",
  ]);

  return {
    status: whoami.ok && builds.ok ? "ok" : "error",
    details: {
      whoami: commandDetail(whoami),
      latestBuilds: summarizeBuilds(parseJsonCommand(builds)),
      submitStatus:
        "Some EAS CLI versions do not expose submit history; use store APIs for final submission state.",
    },
  };
}

function getEasCliPackage() {
  const configuredVersion = easJson.cli?.version?.match(/\d+\.\d+\.\d+/)?.[0];

  return `eas-cli@${configuredVersion ?? "latest"}`;
}

async function getGooglePlayStatus(
  packageName: string | undefined,
  track: string,
): Promise<StatusSection> {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!packageName) {
    return missing("Missing Android package. Set expo.android.package or --android-package.");
  }

  if (!keyPath) {
    return missing("Set GOOGLE_SERVICE_ACCOUNT_KEY in --env, .env.release, or shell env.");
  }

  try {
    const token = await getGoogleAccessToken(keyPath);
    const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}`;
    const edit = await googleFetch(`${base}/edits`, token, { method: "POST" });
    const editId = edit.id;

    try {
      const trackStatus = await googleFetch(`${base}/edits/${editId}/tracks/${track}`, token);

      return {
        status: "ok",
        details: {
          packageName,
          track,
          releases: trackStatus.releases ?? [],
          note: "Uses a temporary uncommitted Google Play edit for read access, then deletes it.",
        },
      };
    } finally {
      await googleFetch(`${base}/edits/${editId}`, token, { method: "DELETE" });
    }
  } catch (error) {
    return errored(error);
  }
}

async function getAppStoreStatus(
  appId: string | undefined,
  version: string | undefined,
): Promise<StatusSection> {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyPath = process.env.ASC_KEY_PATH;

  if (!appId) {
    return missing(
      "Missing App Store Connect app id. Set eas submit.production.ios.ascAppId or --asc-app-id.",
    );
  }

  if (!version) {
    return missing("Missing release version. Set expo.version or --release-version.");
  }

  if (!keyId || !issuerId || !keyPath) {
    return missing(
      "Set ASC_KEY_ID, ASC_ISSUER_ID, and ASC_KEY_PATH in --env, .env.release, or shell env.",
    );
  }

  try {
    const token = createAppleToken(keyId, issuerId, keyPath);
    const headers = { Authorization: `Bearer ${token}` };
    const versionUrl = new URL(
      `https://api.appstoreconnect.apple.com/v1/apps/${appId}/appStoreVersions`,
    );
    versionUrl.searchParams.set("filter[platform]", "IOS");
    versionUrl.searchParams.set("filter[versionString]", version);
    versionUrl.searchParams.set("include", "build");
    versionUrl.searchParams.set("limit", "1");

    const versionResponse = await fetchJson(versionUrl, { headers });

    if (!versionResponse.data?.[0]) {
      return missing(`No iOS App Store version ${version} found.`);
    }

    const reviewUrl = new URL("https://api.appstoreconnect.apple.com/v1/reviewSubmissions");
    reviewUrl.searchParams.set("filter[app]", appId);
    reviewUrl.searchParams.set("limit", "5");

    const reviewResponse = await fetchJson(reviewUrl, { headers });

    return {
      status: "ok",
      details: {
        appId,
        version: summarizeAppleVersion(versionResponse),
        reviewSubmissions:
          reviewResponse.data?.map((submission: any) => ({
            id: submission.id,
            state: submission.attributes?.state,
            submittedDate: submission.attributes?.submittedDate,
          })) ?? [],
      },
    };
  } catch (error) {
    return errored(error);
  }
}

async function getGoogleAccessToken(keyPath: string): Promise<string> {
  const key = readJson<{ client_email: string; private_key: string }>(resolvePath(keyPath));
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    key.private_key,
    "RSA-SHA256",
  );

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  return response.access_token;
}

function createAppleToken(keyId: string, issuerId: string, keyPath: string): string {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = readFileSync(resolvePath(keyPath), "utf8");

  return signJwt(
    { alg: "ES256", kid: keyId, typ: "JWT" },
    {
      iss: issuerId,
      aud: "appstoreconnect-v1",
      iat: now,
      exp: now + 20 * 60,
    },
    privateKey,
    "SHA256",
  );
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: string,
  algorithm: string,
): string {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signer = createSign(algorithm);
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKey));
  const jwtSignature = header.alg === "ES256" ? ecdsaDerToJose(signature) : signature;

  return `${encodedHeader}.${encodedPayload}.${base64Url(jwtSignature)}`;
}

function ecdsaDerToJose(signature: Buffer) {
  let offset = signature[1] & 0x80 ? 3 : 2;

  if (signature[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature");
  }

  const rLength = signature[offset + 1];
  const r = normalizeEcdsaInteger(signature.subarray(offset + 2, offset + 2 + rLength));
  offset = offset + 2 + rLength;

  if (signature[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature");
  }

  const sLength = signature[offset + 1];
  const s = normalizeEcdsaInteger(signature.subarray(offset + 2, offset + 2 + sLength));

  return Buffer.concat([r, s]);
}

function normalizeEcdsaInteger(value: Buffer) {
  const stripped = value[0] === 0 ? value.subarray(1) : value;

  if (stripped.length > 32) {
    throw new Error("Invalid ES256 signature length");
  }

  return Buffer.concat([Buffer.alloc(32 - stripped.length), stripped]);
}

async function googleFetch(url: string, token: string, init: RequestInit = {}) {
  return fetchJson(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

async function fetchJson(url: string | URL, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

function summarizeAppleVersion(response: any) {
  const versionData = response.data?.[0];
  const buildId = versionData?.relationships?.build?.data?.id;
  const build = response.included?.find(
    (item: any) => item.type === "builds" && item.id === buildId,
  );

  if (!versionData) {
    return null;
  }

  return {
    id: versionData.id,
    versionString: versionData.attributes?.versionString,
    appStoreState: versionData.attributes?.appStoreState,
    build: build
      ? {
          id: build.id,
          version: build.attributes?.version,
          processingState: build.attributes?.processingState,
        }
      : null,
  };
}

function run(args: string[]) {
  try {
    const result = Bun.spawnSync(args, {
      cwd: mobileDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      command: args.join(" "),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: String(error),
      command: args.join(" "),
    };
  }
}

function parseJsonCommand(command: ReturnType<typeof run>) {
  if (!command.ok) {
    return commandDetail(command);
  }

  try {
    return JSON.parse(command.stdout);
  } catch {
    return commandDetail(command);
  }
}

function summarizeBuilds(value: unknown) {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((build: any) => ({
    id: build.id,
    status: build.status,
    platform: build.platform,
    buildProfile: build.buildProfile,
    appVersion: build.appVersion,
    appBuildVersion: build.appBuildVersion,
    gitCommitHash: build.gitCommitHash,
    createdAt: build.createdAt,
    completedAt: build.completedAt,
    artifactUrl: build.artifacts?.applicationArchiveUrl ?? build.artifacts?.buildUrl ?? null,
  }));
}

function commandDetail(command: ReturnType<typeof run>) {
  return {
    command: command.command,
    ok: command.ok,
    exitCode: command.exitCode,
    stdout: command.stdout.trim(),
    stderr: command.stderr.trim(),
  };
}

function loadEnvFile(envPath: string) {
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = trimmed
      .slice(0, separator)
      .trim()
      .replace(/^export\s+/, "");
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");

    process.env[key] ??= expandEnvVariables(value);
  }
}

function parseArgs(rawArgs: string[]) {
  const parsed = new Map<string, string[]>();

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? (rawArgs[index + 1]?.startsWith("--") ? "" : rawArgs[++index]);

    parsed.set(rawKey, [...(parsed.get(rawKey) ?? []), value ?? ""]);
  }

  if (parsed.has("help")) {
    printHelpAndExit();
  }

  return {
    get: (key: string) => parsed.get(key)?.at(-1),
    getAll: (key: string) => parsed.get(key) ?? [],
    has: (key: string) => parsed.has(key),
  };
}

function requiredArg(parsed: ReturnType<typeof parseArgs>, key: string) {
  const value = parsed.get(key);

  if (!value) {
    console.error(`Missing required --${key}`);
    printHelpAndExit(1);
  }

  return value;
}

function getPlatform(value: string): Platform {
  if (value === "android" || value === "ios" || value === "all") {
    return value;
  }

  throw new Error(`Invalid --platform ${value}. Expected android, ios, or all.`);
}

function resolvePath(path: string) {
  return expandEnvVariables(path).replace(/^~(?=\/)/, process.env.HOME ?? "");
}

function expandEnvVariables(value: string) {
  return value.replace(/\$(?:\{([A-Z0-9_]+)\}|([A-Z0-9_]+))/g, (match, braced, bare) => {
    return process.env[braced ?? bare] ?? match;
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function missing(message: string): StatusSection {
  return { status: "missing", details: { message } };
}

function skipped(message: string): StatusSection {
  return { status: "skipped", details: { message } };
}

function errored(error: unknown): StatusSection {
  return {
    status: "error",
    details: {
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function finish() {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [name, section] of Object.entries(report)) {
      console.log(`\n# ${name} [${section.status}]`);
      console.log(JSON.stringify(section.details, null, 2));
    }
  }

  process.exitCode = Object.values(report).some(
    (section) => section.status === "missing" || section.status === "error",
  )
    ? 1
    : 0;
}

function printHelpAndExit(code = 0): never {
  console.log(`Usage:
  bun mobile-store-status.ts --project-root <path> --mobile-dir <path> [options]

Options:
  --env <path>                Load release API env file. Can be repeated.
  --platform android|ios|all  Default: all.
  --local-only                Read local app/EAS config only.
  --json                      Print JSON output.
  --release-version <value>   Override Expo app version.
  --android-package <value>   Override Android package name.
  --google-track <value>      Override Google Play track. Default: production.
  --ios-bundle-id <value>     Override iOS bundle identifier.
  --asc-app-id <value>        Override App Store Connect app id.
`);
  process.exit(code);
}
