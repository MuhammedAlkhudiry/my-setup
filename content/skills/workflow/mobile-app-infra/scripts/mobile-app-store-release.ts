#!/usr/bin/env bun

import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Command = "prepare" | "submit";

type ExpoConfig = {
  expo?: {
    version?: string;
  };
};

type EasConfig = {
  submit?: {
    production?: {
      ios?: {
        ascAppId?: string;
      };
    };
  };
};

type AppleResource = {
  id: string;
  attributes?: Record<string, any>;
  relationships?: Record<string, { data?: AppleResource | AppleResource[] | null }>;
};

const args = parseArgs(process.argv.slice(2));
const command = getCommand(args.command);
const projectRoot = resolve(requiredOption(args, "project-root"));
const mobileDir = resolve(projectRoot, requiredOption(args, "mobile-dir"));
const envPath = resolvePath(requiredOption(args, "env"));
const appJson = readJson<ExpoConfig>(resolve(mobileDir, "app.json"));
const easJson = readJson<EasConfig>(resolve(mobileDir, "eas.json"));
const appId = requiredValue(
  args.options.get("asc-app-id") ?? easJson.submit?.production?.ios?.ascAppId,
  "Missing App Store Connect app id. Set eas submit.production.ios.ascAppId or --asc-app-id.",
);
const versionString = requiredValue(
  args.options.get("release-version") ?? appJson.expo?.version,
  "Missing release version. Set expo.version or --release-version.",
);
const buildNumber = args.options.get("build");
const locale = args.options.get("locale") ?? "en-US";
const whatsNew = args.options.get("whats-new");

if (command === "prepare" && !buildNumber) {
  throw new Error("Missing --build for prepare.");
}

if (command === "prepare" && !whatsNew) {
  throw new Error("Missing --whats-new for prepare.");
}

loadEnvFile(envPath);
const headers = appleHeaders();

if (command === "prepare") {
  await prepareRelease();
} else {
  await submitRelease();
}

async function prepareRelease() {
  const build = await getBuild(buildNumber!);

  if (build.attributes?.processingState !== "VALID") {
    throw new Error(`Build ${buildNumber} is ${build.attributes?.processingState ?? "not ready"}.`);
  }

  const previousVersion = await getLatestVersionBefore(versionString);
  const version = (await getVersion(versionString)) ?? (await createVersion(previousVersion));

  await ensureLocalization(version, previousVersion);
  await ensureReviewDetails(version, previousVersion);
  await attachBuild(version, build);

  console.log({
    prepared: true,
    versionId: version.id,
    version: versionString,
    buildId: build.id,
    build: buildNumber,
  });
}

async function submitRelease() {
  const version = await getVersion(versionString);

  if (!version) {
    throw new Error(`App Store version ${versionString} does not exist. Run prepare first.`);
  }

  const activeSubmissions = (await getReviewSubmissions()).filter((review) =>
    ["READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"].includes(
      review.attributes?.state,
    ),
  );

  const existing = await findSubmissionForVersion(activeSubmissions, version.id);

  // App Review rejected this version. Once prepare attaches the fixed build, the same submission goes
  // back to review; reporting it as submitted would leave the release rejected.
  if (existing?.attributes?.state === "UNRESOLVED_ISSUES") {
    const resubmitted = await markSubmitted(existing.id);

    console.log({
      submitted: true,
      resubmitted: true,
      reviewId: existing.id,
      state: resubmitted.attributes?.state,
    });
    return;
  }

  if (existing) {
    console.log({
      submitted: true,
      reviewId: existing.id,
      state: existing.attributes?.state,
    });
    return;
  }

  if (activeSubmissions.length > 0) {
    throw new Error(
      `Active App Store review submission ${activeSubmissions[0]!.id} does not contain version ${versionString}.`,
    );
  }

  const review = await appleJson("https://api.appstoreconnect.apple.com/v1/reviewSubmissions", {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: {
          app: { data: { type: "apps", id: appId } },
        },
      },
    }),
  }).then((response) => response.data);

  await appleJson("https://api.appstoreconnect.apple.com/v1/reviewSubmissionItems", {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: review.id },
          },
          appStoreVersion: {
            data: { type: "appStoreVersions", id: version.id },
          },
        },
      },
    }),
  });

  const submitted = await markSubmitted(review.id);

  console.log({
    submitted: true,
    reviewId: review.id,
    state: submitted.attributes?.state,
  });
}

async function markSubmitted(reviewId: string): Promise<AppleResource> {
  return appleJson(`https://api.appstoreconnect.apple.com/v1/reviewSubmissions/${reviewId}`, {
    method: "PATCH",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      data: {
        type: "reviewSubmissions",
        id: reviewId,
        attributes: { submitted: true },
      },
    }),
  }).then((response) => response.data);
}

async function createVersion(previousVersion: AppleResource | null) {
  const attributes: Record<string, unknown> = {
    platform: "IOS",
    versionString,
    releaseType: previousVersion?.attributes?.releaseType ?? "AFTER_APPROVAL",
  };

  if (previousVersion?.attributes?.copyright) {
    attributes.copyright = previousVersion.attributes.copyright;
  }

  return appleJson("https://api.appstoreconnect.apple.com/v1/appStoreVersions", {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      data: {
        type: "appStoreVersions",
        attributes,
        relationships: {
          app: { data: { type: "apps", id: appId } },
        },
      },
    }),
  }).then((response) => response.data as AppleResource);
}

async function ensureLocalization(version: AppleResource, previousVersion: AppleResource | null) {
  const existing = await getLocalizations(version.id);
  const current = existing.find((item) => item.attributes?.locale === locale);

  if (current) {
    await appleJson(
      `https://api.appstoreconnect.apple.com/v1/appStoreVersionLocalizations/${current.id}`,
      {
        method: "PATCH",
        headers: jsonHeaders(headers),
        body: JSON.stringify({
          data: {
            type: "appStoreVersionLocalizations",
            id: current.id,
            attributes: { whatsNew },
          },
        }),
      },
    );
    return;
  }

  const previous = previousVersion ? await getLocalizations(previousVersion.id) : [];
  const source = previous.find((item) => item.attributes?.locale === locale) ?? previous[0];
  const attributes: Record<string, unknown> = {
    locale,
    whatsNew,
  };

  for (const key of ["description", "keywords", "marketingUrl", "promotionalText", "supportUrl"]) {
    if (source?.attributes?.[key]) {
      attributes[key] = source.attributes[key];
    }
  }

  await appleJson("https://api.appstoreconnect.apple.com/v1/appStoreVersionLocalizations", {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      data: {
        type: "appStoreVersionLocalizations",
        attributes,
        relationships: {
          appStoreVersion: {
            data: { type: "appStoreVersions", id: version.id },
          },
        },
      },
    }),
  });
}

async function ensureReviewDetails(version: AppleResource, previousVersion: AppleResource | null) {
  if (await getReviewDetails(version.id)) {
    return;
  }

  const previous = previousVersion ? await getReviewDetails(previousVersion.id) : null;

  if (!previous) {
    throw new Error("No previous App Store review details are available to preserve.");
  }

  const attributes: Record<string, unknown> = {};

  for (const key of [
    "contactFirstName",
    "contactLastName",
    "contactPhone",
    "contactEmail",
    "demoAccountName",
    "demoAccountPassword",
    "demoAccountRequired",
    "notes",
  ]) {
    const value = previous.attributes?.[key];

    if (value !== undefined && value !== null) {
      attributes[key] = value;
    }
  }

  await appleJson("https://api.appstoreconnect.apple.com/v1/appStoreReviewDetails", {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      data: {
        type: "appStoreReviewDetails",
        attributes,
        relationships: {
          appStoreVersion: {
            data: { type: "appStoreVersions", id: version.id },
          },
        },
      },
    }),
  });
}

async function attachBuild(version: AppleResource, build: AppleResource) {
  await appleJson(
    `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${version.id}/relationships/build`,
    {
      method: "PATCH",
      headers: jsonHeaders(headers),
      body: JSON.stringify({
        data: { type: "builds", id: build.id },
      }),
    },
  );
}

async function getVersion(version: string): Promise<AppleResource | null> {
  const url = new URL(`https://api.appstoreconnect.apple.com/v1/apps/${appId}/appStoreVersions`);
  url.searchParams.set("filter[platform]", "IOS");
  url.searchParams.set("filter[versionString]", version);
  url.searchParams.set("limit", "1");

  return appleJson(url, { headers }).then((response) => response.data?.[0] ?? null);
}

async function getLatestVersionBefore(version: string): Promise<AppleResource | null> {
  const url = new URL(`https://api.appstoreconnect.apple.com/v1/apps/${appId}/appStoreVersions`);
  url.searchParams.set("filter[platform]", "IOS");
  url.searchParams.set("limit", "50");
  const versions: AppleResource[] = await appleJson(url, { headers }).then(
    (response) => response.data ?? [],
  );

  return (
    versions
      .filter((item) => {
        const candidate = item.attributes?.versionString;

        return typeof candidate === "string" && compareVersions(candidate, version) < 0;
      })
      .sort((left, right) => {
        const versionOrder = compareVersions(
          String(right.attributes?.versionString),
          String(left.attributes?.versionString),
        );

        if (versionOrder !== 0) {
          return versionOrder;
        }

        return (
          Date.parse(String(right.attributes?.createdDate ?? "")) -
          Date.parse(String(left.attributes?.createdDate ?? ""))
        );
      })[0] ?? null
  );
}

async function getBuild(number: string): Promise<AppleResource> {
  const url = new URL("https://api.appstoreconnect.apple.com/v1/builds");
  url.searchParams.set("filter[app]", appId);
  url.searchParams.set("filter[version]", number);
  url.searchParams.set("limit", "1");
  const build = await appleJson(url, { headers }).then((response) => response.data?.[0]);

  if (!build) {
    throw new Error(`Build ${number} is not available in App Store Connect.`);
  }

  return build;
}

async function getLocalizations(versionId: string): Promise<AppleResource[]> {
  return appleJson(
    `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    { headers },
  ).then((response) => response.data ?? []);
}

async function getReviewDetails(versionId: string): Promise<AppleResource | null> {
  return appleJson(
    `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${versionId}/appStoreReviewDetail`,
    { headers },
  )
    .then((response) => response.data ?? null)
    .catch((error) => {
      if (String(error.message).startsWith("404 ")) {
        return null;
      }

      throw error;
    });
}

async function getReviewSubmissions(): Promise<AppleResource[]> {
  const url = new URL("https://api.appstoreconnect.apple.com/v1/reviewSubmissions");
  url.searchParams.set("filter[app]", appId);
  url.searchParams.set("limit", "10");

  return appleJson(url, { headers }).then((response) => response.data ?? []);
}

async function findSubmissionForVersion(
  submissions: AppleResource[],
  versionId: string,
): Promise<AppleResource | null> {
  for (const submission of submissions) {
    const url = new URL(
      `https://api.appstoreconnect.apple.com/v1/reviewSubmissions/${submission.id}/items`,
    );
    url.searchParams.set("include", "appStoreVersion");

    const response = await appleJson(url, { headers });
    const items: AppleResource[] = response.data ?? [];
    const includesVersion = items.some((item) => {
      const relatedVersion = item.relationships?.appStoreVersion?.data;
      const relatedResource = Array.isArray(relatedVersion) ? relatedVersion[0] : relatedVersion;

      return relatedResource?.id === versionId;
    });

    if (includesVersion) {
      return submission;
    }
  }

  return null;
}

function compareVersions(left: string, right: string) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  if (!leftParts || !rightParts) {
    return 0;
  }

  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function parseVersion(value: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(value)) {
    return null;
  }

  return value.split(".").map(Number);
}

function appleHeaders() {
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId, ASC_KEY_PATH: keyPath } = process.env;

  if (!keyId || !issuerId || !keyPath) {
    throw new Error(`Missing ASC_KEY_ID, ASC_ISSUER_ID, or ASC_KEY_PATH in ${envPath}.`);
  }

  return {
    Authorization: `Bearer ${createAppleToken(keyId, issuerId, keyPath)}`,
  };
}

function createAppleToken(keyId: string, issuerId: string, keyPath: string) {
  const now = Math.floor(Date.now() / 1000);

  return signJwt(
    { alg: "ES256", kid: keyId, typ: "JWT" },
    {
      iss: issuerId,
      aud: "appstoreconnect-v1",
      iat: now,
      exp: now + 20 * 60,
    },
    readFileSync(resolvePath(keyPath), "utf8"),
  );
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: string,
) {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signer = createSign("SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = ecdsaDerToJose(signer.sign(createPrivateKey(privateKey)));

  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

function ecdsaDerToJose(signature: Buffer) {
  let offset = signature[1] & 0x80 ? 3 : 2;

  if (signature[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature");
  }

  const rLength = signature[offset + 1];
  const r = normalizeInteger(signature.subarray(offset + 2, offset + 2 + rLength));
  offset += 2 + rLength;

  if (signature[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature");
  }

  const sLength = signature[offset + 1];
  const s = normalizeInteger(signature.subarray(offset + 2, offset + 2 + sLength));

  return Buffer.concat([r, s]);
}

function normalizeInteger(value: Buffer) {
  const stripped = value[0] === 0 ? value.subarray(1) : value;

  if (stripped.length > 32) {
    throw new Error("Invalid ES256 signature length");
  }

  return Buffer.concat([Buffer.alloc(32 - stripped.length), stripped]);
}

async function appleJson(url: string | URL, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

function jsonHeaders(authHeaders: Record<string, string>) {
  return {
    ...authHeaders,
    "Content-Type": "application/json",
  };
}

function loadEnvFile(path: string) {
  if (!existsSync(path)) {
    throw new Error(`Release environment file does not exist: ${path}`);
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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

function expandEnvVariables(value: string) {
  return value.replace(
    /\$(?:\{([A-Z0-9_]+)\}|([A-Z0-9_]+))/g,
    (_, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain!;

      return process.env[name] ?? `$${name}`;
    },
  );
}

function resolvePath(path: string) {
  const expanded = expandEnvVariables(path);

  return expanded.startsWith("/") ? expanded : resolve(projectRoot, expanded);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function parseArgs(rawArgs: string[]) {
  let command: string | undefined;
  const options = new Map<string, string>();

  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];

    if (argument === "--help" || argument === "-h") {
      printHelpAndExit();
    }

    if (!argument.startsWith("--")) {
      if (command) {
        throw new Error(`Unexpected argument: ${argument}`);
      }

      command = argument;
      continue;
    }

    const [key, inlineValue] = argument.slice(2).split("=", 2);
    const value =
      inlineValue ?? (rawArgs[index + 1]?.startsWith("--") ? undefined : rawArgs[++index]);

    if (!value) {
      throw new Error(`Missing value for --${key}.`);
    }

    options.set(key, value);
  }

  return { command, options };
}

function getCommand(value: string | undefined): Command {
  if (value === "prepare" || value === "submit") {
    return value;
  }

  console.error(value ? `Unknown command: ${value}` : "Missing command.");
  printHelpAndExit(1);
}

function requiredOption(args: ReturnType<typeof parseArgs>, key: string) {
  const value = args.options.get(key);

  if (!value) {
    console.error(`Missing required --${key}.`);
    printHelpAndExit(1);
  }

  return value;
}

function requiredValue(value: string | undefined, message: string) {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function printHelpAndExit(exitCode = 0): never {
  console.log(`Usage:
  bun scripts/mobile-app-store-release.ts <prepare|submit> \\
    --project-root <path> \\
    --mobile-dir <path> \\
    --env <path> [options]

Commands:
  prepare  Create or update the App Store version, preserve prior metadata,
           set release notes, and attach a processed build.
  submit   Submit the prepared App Store version through Apple's current
           review-submission API. Reuses an active submission when present.

Required options:
  --project-root <path>     Target repository root.
  --mobile-dir <path>       Mobile app directory, relative to project root.
  --env <path>              Environment file containing ASC_KEY_ID,
                            ASC_ISSUER_ID, and ASC_KEY_PATH.

Prepare options:
  --build <value>           Processed App Store build number. Required.
  --whats-new <text>        Localized release notes. Required.

Shared options:
  --release-version <value> Store version. Defaults to expo.version in app.json.
  --asc-app-id <id>         App Store Connect app id. Defaults to
                            submit.production.ios.ascAppId in eas.json.
  --locale <value>          App Store localization. Default: en-US.
`);
  process.exit(exitCode);
}
