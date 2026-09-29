#!/usr/bin/env bun

import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Command = "update-google" | "update-apple" | "update-all";

type ExpoConfig = {
  expo?: {
    version?: string;
    android?: {
      package?: string;
    };
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

type Screenshot = {
  file: string;
  bytes: Uint8Array<ArrayBuffer>;
  size: number;
};

const args = parseArgs(process.argv.slice(2));
const command = getCommand(args.command);
const projectRoot = resolve(requiredOption(args, "project-root"));
const mobileDir = resolve(projectRoot, requiredOption(args, "mobile-dir"));
const envPath = resolvePath(requiredOption(args, "env"));
const screenshotsDir = resolvePath(requiredOption(args, "screenshots-dir"));

if (!args.flags.has("confirm")) {
  throw new Error("Missing --confirm. Store screenshot replacement is destructive.");
}

const appJson = readJson<ExpoConfig>(resolve(mobileDir, "app.json"));
const easJson = readJson<EasConfig>(resolve(mobileDir, "eas.json"));
const versionString = args.options.get("release-version") ?? appJson.expo?.version;
const packageName = args.options.get("android-package") ?? appJson.expo?.android?.package;
const appId = args.options.get("asc-app-id") ?? easJson.submit?.production?.ios?.ascAppId;
const googleLanguage = args.options.get("google-language");
const googleImageType = args.options.get("google-image-type") ?? "phoneScreenshots";
const appleLocale = args.options.get("apple-locale");
const appleDisplayType = args.options.get("apple-display-type");
const screenshots = loadScreenshots();

validateProviderOptions();
loadEnvFile(envPath);

if (command === "update-google") {
  await updateGoogleScreenshots();
} else if (command === "update-apple") {
  await updateAppleScreenshots();
} else {
  await updateGoogleScreenshots();
  await updateAppleScreenshots();
}

function validateProviderOptions() {
  if (command === "update-google" || command === "update-all") {
    requiredValue(
      packageName,
      "Missing Android package. Set expo.android.package or --android-package.",
    );
    requiredValue(
      googleLanguage,
      "Missing --google-language for Google Play screenshot replacement.",
    );
  }

  if (command === "update-apple" || command === "update-all") {
    requiredValue(
      appId,
      "Missing App Store Connect app id. Set eas submit.production.ios.ascAppId or --asc-app-id.",
    );
    requiredValue(versionString, "Missing release version. Set expo.version or --release-version.");
    requiredValue(appleLocale, "Missing --apple-locale for App Store screenshot replacement.");
    requiredValue(
      appleDisplayType,
      "Missing --apple-display-type for App Store screenshot replacement.",
    );
  }
}

async function updateGoogleScreenshots() {
  const token = await getGoogleAccessToken();
  const base = googleBase();
  const edit = await googleJson(`${base}/edits`, token, {
    method: "POST",
  });

  console.log("Google edit", edit.id);

  try {
    await googleJson(
      `${base}/edits/${edit.id}/listings/${googleLanguage}/${googleImageType}`,
      token,
      { method: "DELETE" },
    ).catch((error) => {
      if (!String(error.message).includes("404")) {
        throw error;
      }
    });

    for (const screenshot of screenshots) {
      await googleJson(
        `${googleUploadBase()}/edits/${edit.id}/listings/${googleLanguage}/${googleImageType}?uploadType=media`,
        token,
        {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: screenshot.bytes,
        },
      );
      console.log("Google uploaded", screenshot.file);
    }

    const images = await googleJson(
      `${base}/edits/${edit.id}/listings/${googleLanguage}/${googleImageType}`,
      token,
    );
    console.log("Google final draft screenshot count", (images.images ?? []).length);

    await googleJson(`${base}/edits/${edit.id}:commit`, token, {
      method: "POST",
    });
    console.log("Google edit committed");
  } catch (error) {
    await googleJson(`${base}/edits/${edit.id}`, token, {
      method: "DELETE",
    }).catch(() => null);
    throw error;
  }
}

async function updateAppleScreenshots() {
  const headers = appleHeaders();
  const version = await getAppleVersion(headers);
  const state = version.attributes?.appStoreState;

  console.log("Apple version", {
    id: version.id,
    version: versionString,
    state,
  });

  if (
    [
      "READY_FOR_SALE",
      "WAITING_FOR_REVIEW",
      "IN_REVIEW",
      "PENDING_APPLE_RELEASE",
      "PENDING_DEVELOPER_RELEASE",
    ].includes(state)
  ) {
    throw new Error(
      `Apple version ${versionString} is ${state}. Default App Store screenshots are replaceable only on an editable version such as PREPARE_FOR_SUBMISSION.`,
    );
  }

  const localization = await getAppleLocalization(headers, version.id);
  let screenshotSet = await getAppleScreenshotSet(headers, localization.id);

  if (!screenshotSet) {
    screenshotSet = await appleJson("https://api.appstoreconnect.apple.com/v1/appScreenshotSets", {
      method: "POST",
      headers: jsonHeaders(headers),
      body: JSON.stringify({
        data: {
          type: "appScreenshotSets",
          attributes: {
            screenshotDisplayType: appleDisplayType,
          },
          relationships: {
            appStoreVersionLocalization: {
              data: {
                type: "appStoreVersionLocalizations",
                id: localization.id,
              },
            },
          },
        },
      }),
    }).then((response) => response.data);
  }

  const existing = await getAppleScreenshots(headers, screenshotSet.id);
  console.log("Apple existing screenshot count", existing.length);

  for (const screenshot of existing) {
    await appleJson(`https://api.appstoreconnect.apple.com/v1/appScreenshots/${screenshot.id}`, {
      method: "DELETE",
      headers,
    });
  }

  const uploaded = [];

  for (const screenshot of screenshots) {
    const reservation = await appleJson("https://api.appstoreconnect.apple.com/v1/appScreenshots", {
      method: "POST",
      headers: jsonHeaders(headers),
      body: JSON.stringify({
        data: {
          type: "appScreenshots",
          attributes: {
            fileName: screenshot.file,
            fileSize: screenshot.size,
          },
          relationships: {
            appScreenshotSet: {
              data: {
                type: "appScreenshotSets",
                id: screenshotSet.id,
              },
            },
          },
        },
      }),
    });

    const screenshotId = reservation.data.id;

    for (const operation of reservation.data.attributes?.uploadOperations ?? []) {
      const offset = Number(operation.offset ?? 0);
      const length = Number(operation.length ?? screenshot.bytes.byteLength);
      const uploadHeaders = Object.fromEntries(
        (operation.requestHeaders ?? []).map((header: any) => [header.name, header.value]),
      );
      const response = await fetch(operation.url, {
        method: operation.method,
        headers: uploadHeaders,
        body: screenshot.bytes.subarray(offset, offset + length),
      });

      if (!response.ok) {
        throw new Error(
          `Apple upload failed for ${screenshot.file}: ${response.status} ${await response.text()}`,
        );
      }
    }

    await appleJson(`https://api.appstoreconnect.apple.com/v1/appScreenshots/${screenshotId}`, {
      method: "PATCH",
      headers: jsonHeaders(headers),
      body: JSON.stringify({
        data: {
          id: screenshotId,
          type: "appScreenshots",
          attributes: { uploaded: true },
        },
      }),
    });

    uploaded.push({
      id: screenshotId,
      file: screenshot.file,
    });
    console.log("Apple uploaded", screenshot.file);
  }

  await appleJson(
    `https://api.appstoreconnect.apple.com/v1/appScreenshotSets/${screenshotSet.id}/relationships/appScreenshots`,
    {
      method: "PATCH",
      headers: jsonHeaders(headers),
      body: JSON.stringify({
        data: uploaded.map((screenshot) => ({
          type: "appScreenshots",
          id: screenshot.id,
        })),
      }),
    },
  );

  const finalScreenshots = await getAppleScreenshots(headers, screenshotSet.id);
  console.log("Apple final screenshot count", finalScreenshots.length);
}

async function getAppleVersion(headers: Record<string, string>): Promise<any> {
  const url = new URL(`https://api.appstoreconnect.apple.com/v1/apps/${appId}/appStoreVersions`);
  url.searchParams.set("filter[platform]", "IOS");
  url.searchParams.set("filter[versionString]", versionString!);
  url.searchParams.set("limit", "1");
  const response = await appleJson(url, { headers });
  const version = response.data?.[0];

  if (!version) {
    throw new Error(`No iOS App Store version ${versionString} found.`);
  }

  return version;
}

async function getAppleLocalization(
  headers: Record<string, string>,
  versionId: string,
): Promise<any> {
  const response = await appleJson(
    `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    { headers },
  );
  const localization = (response.data ?? []).find(
    (item: any) => item.attributes?.locale === appleLocale,
  );

  if (!localization) {
    throw new Error(`No App Store version localization ${appleLocale} found.`);
  }

  return localization;
}

async function getAppleScreenshotSet(
  headers: Record<string, string>,
  localizationId: string,
): Promise<any> {
  const url = new URL(
    `https://api.appstoreconnect.apple.com/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
  );
  url.searchParams.set("filter[screenshotDisplayType]", appleDisplayType!);
  url.searchParams.set("limit", "50");
  const response = await appleJson(url, { headers });

  return response.data?.[0] ?? null;
}

async function getAppleScreenshots(
  headers: Record<string, string>,
  screenshotSetId: string,
): Promise<any[]> {
  const url = new URL(
    `https://api.appstoreconnect.apple.com/v1/appScreenshotSets/${screenshotSetId}/appScreenshots`,
  );
  url.searchParams.set("limit", "50");
  const response = await appleJson(url, { headers });

  return response.data ?? [];
}

function loadScreenshots(): Screenshot[] {
  if (!existsSync(screenshotsDir)) {
    throw new Error(`Screenshots directory does not exist: ${screenshotsDir}`);
  }

  const screenshots = readdirSync(screenshotsDir)
    .filter((file) => /^\d+\.png$/.test(file))
    .sort((left, right) => {
      const numericDifference =
        Number(left.slice(0, -".png".length)) - Number(right.slice(0, -".png".length));

      return numericDifference || left.localeCompare(right);
    })
    .map((file) => {
      const buffer = readFileSync(resolve(screenshotsDir, file));
      const bytes = new Uint8Array(buffer.byteLength);
      bytes.set(buffer);

      return {
        file,
        bytes,
        size: bytes.byteLength,
      };
    });

  if (screenshots.length === 0 || screenshots.length > 10) {
    throw new Error(
      `Expected 1-10 numbered PNG screenshots in ${screenshotsDir}; found ${screenshots.length}.`,
    );
  }

  return screenshots;
}

async function getGoogleAccessToken(): Promise<string> {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!keyPath) {
    throw new Error(`Missing GOOGLE_SERVICE_ACCOUNT_KEY in ${envPath}.`);
  }

  const key = readJson<{
    client_email: string;
    private_key: string;
  }>(resolvePath(keyPath));
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
  const response = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  return response.access_token;
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
    "SHA256",
  );
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: string,
  algorithm: string,
) {
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
  offset += 2 + rLength;

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

async function googleJson(url: string, token: string, init: RequestInit = {}): Promise<any> {
  return fetchJson(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

async function appleJson(url: string | URL, init: RequestInit = {}): Promise<any> {
  return fetchJson(url, init);
}

async function fetchJson(url: string | URL, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

function googleBase() {
  return `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}`;
}

function googleUploadBase() {
  return `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}`;
}

function jsonHeaders(headers: Record<string, string>) {
  return {
    ...headers,
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
  const flags = new Set<string>();

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

    if (key === "confirm") {
      flags.add(key);
      continue;
    }

    const value =
      inlineValue ?? (rawArgs[index + 1]?.startsWith("--") ? undefined : rawArgs[++index]);

    if (!value) {
      throw new Error(`Missing value for --${key}.`);
    }

    options.set(key, value);
  }

  return { command, options, flags };
}

function getCommand(value: string | undefined): Command {
  if (value === "update-google" || value === "update-apple" || value === "update-all") {
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
  bun scripts/mobile-store-screenshots.ts <command> \\
    --project-root <path> \\
    --mobile-dir <path> \\
    --env <path> \\
    --screenshots-dir <path> \\
    --confirm [provider options]

Commands:
  update-google  Replace one Google Play listing image set and commit the edit.
  update-apple   Replace one App Store Connect screenshot set on an editable version.
  update-all     Run Google Play replacement, then App Store Connect replacement.

Required options:
  --project-root <path>       Target repository root.
  --mobile-dir <path>         Mobile app directory, relative to project root.
  --env <path>                Provider credential environment file.
  --screenshots-dir <path>    Directory containing 1-10 numbered PNG files.
  --confirm                   Confirm destructive store screenshot replacement.

Google options:
  --google-language <value>   Required for Google commands, for example ar.
  --google-image-type <value> Google image set. Default: phoneScreenshots.
  --android-package <value>   Defaults to expo.android.package in app.json.

Apple options:
  --apple-locale <value>       Required for Apple commands, for example en-US.
  --apple-display-type <value> Required for Apple commands, for example APP_IPHONE_67.
  --release-version <value>    Defaults to expo.version in app.json.
  --asc-app-id <value>         Defaults to submit.production.ios.ascAppId in eas.json.
`);
  process.exit(exitCode);
}
