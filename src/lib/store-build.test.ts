import { expect, test } from "bun:test";

import {
  type IntrospectedConfig,
  appGroupGaps,
  appGroupRepair,
  easProfiles,
  missingSecrets,
  parseEasVariables,
  profileAppGroups,
  signingTargets,
  storeBuildEnv,
  xcodePinBlocksLocal,
} from "./store-build";

const listing = `
Name          EXPO_PUBLIC_POSTHOG_ENABLED
Value         true
Visibility    PUBLIC
———
Name          GOOGLE_SERVICES_JSON
Visibility    SECRET
———
Name          HUGEICONS_TOKEN
Visibility    SECRET
———
Name          SENTRY_AUTH_TOKEN
Visibility    SENSITIVE
`;

const noFiles = { allowMissing: [], hasSentryLogin: false, fileExists: () => false };

test("reads each variable's name and visibility from the long listing", () => {
  expect(parseEasVariables(listing)).toEqual([
    { name: "EXPO_PUBLIC_POSTHOG_ENABLED", visibility: "PUBLIC" },
    { name: "GOOGLE_SERVICES_JSON", visibility: "SECRET" },
    { name: "HUGEICONS_TOKEN", visibility: "SECRET" },
    { name: "SENTRY_AUTH_TOKEN", visibility: "SENSITIVE" },
  ]);
});

test("requires only secret variables, which EAS keeps from local builds", () => {
  expect(missingSecrets(parseEasVariables(listing), {}, noFiles)).toEqual(["GOOGLE_SERVICES_JSON", "HUGEICONS_TOKEN"]);
});

test("a secret given as an absolute path must point at a file", () => {
  const env = { GOOGLE_SERVICES_JSON: "/app/google-services.json", HUGEICONS_TOKEN: "x" };

  expect(missingSecrets(parseEasVariables(listing), env, noFiles)).toEqual([
    "GOOGLE_SERVICES_JSON (no file at /app/google-services.json)",
  ]);
  expect(missingSecrets(parseEasVariables(listing), env, { ...noFiles, fileExists: () => true })).toEqual([]);
});

test("allowed secrets and a saved Sentry login satisfy the check", () => {
  const variables = [
    { name: "NPM_TOKEN", visibility: "SECRET" },
    { name: "SENTRY_AUTH_TOKEN", visibility: "SECRET" },
  ];

  expect(missingSecrets(variables, {}, { ...noFiles, allowMissing: ["NPM_TOKEN"], hasSentryLogin: true })).toEqual([]);
  expect(missingSecrets(variables, {}, noFiles)).toEqual(["NPM_TOKEN", "SENTRY_AUTH_TOKEN"]);
});

test("an image pinned to an older Xcode major keeps iOS off this Mac", () => {
  const local = "Xcode 27.0\nBuild version 27A266a";

  expect(xcodePinBlocksLocal("macos-tahoe-26.5-xcode-26.6", local)).toBe(true);
  expect(xcodePinBlocksLocal("macos-tahoe-26.6-xcode-27.0", local)).toBe(false);
  expect(xcodePinBlocksLocal("latest", local)).toBe(false);
  expect(xcodePinBlocksLocal(undefined, local)).toBe(false);
});

test("drops shell EXPO_PUBLIC_ variables so the EAS environment supplies them", () => {
  expect(storeBuildEnv({ EXPO_PUBLIC_API_URL: "http://localhost", HOME: "/h" })).toEqual({ HOME: "/h" });
});

const GROUP = "group.com.example.app.shared";
const OTHER_GROUP = "group.com.example.app.blocker";
const groupsOf = (...groups: string[]) => ({ "com.apple.security.application-groups": groups });

const config: IntrospectedConfig = {
  name: "Example",
  ios: { bundleIdentifier: "com.example.app", entitlements: { ...groupsOf(GROUP), "aps-environment": "production" } },
  extra: {
    eas: {
      projectId: "project-id",
      build: {
        experimental: {
          ios: {
            appExtensions: [
              {
                targetName: "Widget",
                bundleIdentifier: "com.example.app.widget",
                entitlements: groupsOf(GROUP, OTHER_GROUP),
              },
              { targetName: "Clip", bundleIdentifier: "com.example.app.clip" },
            ],
          },
        },
      },
    },
  },
};

// A profile is a signed DER blob around a plist, so the plist sits between binary bytes.
function profile(groups: string[] | undefined): string {
  const list = groups?.length ? `<array>${groups.map((group) => `<string>${group}</string>`).join("")}</array>` : "<array/>";
  const entitlements = groups ? `<key>com.apple.security.application-groups</key>\n\t\t${list}` : "";
  const plist =
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Entitlements</key><dict>' +
    `${entitlements}<key>keychain-access-groups</key><array><string>TEAM.*</string></array></dict></dict></plist>`;

  return Buffer.from(`\x30\x82\x41\x9f\x06\x09${plist}\x00\xa0\x82`, "latin1").toString("base64");
}

test("lists the app and each declared extension with the App Groups its entitlements configure", () => {
  expect(signingTargets(config)).toEqual([
    { name: "Example", bundleIdentifier: "com.example.app", appGroups: [GROUP] },
    { name: "Widget", bundleIdentifier: "com.example.app.widget", appGroups: [GROUP, OTHER_GROUP] },
    { name: "Clip", bundleIdentifier: "com.example.app.clip", appGroups: [] },
  ]);
  expect(signingTargets({ ios: { bundleIdentifier: "com.example.app" } })).toEqual([
    { name: "app", bundleIdentifier: "com.example.app", appGroups: [] },
  ]);
});

test("reads the App Groups a provisioning profile grants", () => {
  expect(profileAppGroups(profile([GROUP, OTHER_GROUP]))).toEqual([GROUP, OTHER_GROUP]);
  expect(profileAppGroups(profile([]))).toEqual([]);
  expect(profileAppGroups(profile(undefined))).toEqual([]);
});

test("maps each bundle identifier to the first App Store profile EAS stores for it", () => {
  const credentials = (bundleIdentifier: string, profiles: (string | null)[]) => ({
    appleAppIdentifier: { bundleIdentifier },
    iosAppBuildCredentialsList: profiles.map((provisioningProfile) => ({ provisioningProfile: { provisioningProfile } })),
  });
  const iosAppCredentials = [
    credentials("com.example.app", ["first", "second"]),
    credentials("com.example.app.widget", [null]),
    credentials("com.example.app.clip", []),
    credentials("com.example.app", ["another team"]),
  ];

  expect(easProfiles({ data: { app: { byId: { iosAppCredentials } } } })).toEqual(new Map([["com.example.app", "first"]]));
});

test("an App Group missing from a target's EAS profile names the target and the group", () => {
  const profiles = new Map([
    ["com.example.app", profile([GROUP])],
    ["com.example.app.widget", profile([GROUP])],
  ]);

  expect(appGroupGaps(signingTargets(config), profiles)).toEqual([`Widget (com.example.app.widget) lacks ${OTHER_GROUP}`]);
});

test("an active profile with an empty group list lacks every configured group", () => {
  const profiles = new Map([
    ["com.example.app", profile([GROUP])],
    ["com.example.app.widget", profile([])],
  ]);

  expect(appGroupGaps(signingTargets(config), profiles)).toEqual([
    `Widget (com.example.app.widget) lacks ${GROUP}, ${OTHER_GROUP}`,
  ]);
});

test("a target with App Groups needs an EAS profile, and one without App Groups is not checked", () => {
  const profiles = new Map([["com.example.app", profile([GROUP])]]);

  expect(appGroupGaps(signingTargets(config), profiles)).toEqual([
    "Widget (com.example.app.widget) has no App Store provisioning profile on EAS",
  ]);
});

test("profiles that hold every configured App Group pass", () => {
  const profiles = new Map([
    ["com.example.app", profile([GROUP, OTHER_GROUP])],
    ["com.example.app.widget", profile([OTHER_GROUP, GROUP])],
  ]);

  expect(appGroupGaps(signingTargets(config), profiles)).toEqual([]);
});

test("the failure lists each gap, then the interactive repair for the build profile", () => {
  const message = appGroupRepair([`Widget (com.example.app.widget) lacks ${GROUP}`], "production");

  expect(message).toContain(`\n- Widget (com.example.app.widget) lacks ${GROUP}\n`);
  expect(message).toContain('choose the "production" build profile');
  expect(message.split("\n").at(-1)).toBe("eas credentials --platform ios");
});
