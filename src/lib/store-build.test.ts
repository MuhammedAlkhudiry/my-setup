import { expect, test } from "bun:test";

import { missingSecrets, parseEasVariables, storeBuildEnv, xcodePinBlocksLocal } from "./store-build";

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
