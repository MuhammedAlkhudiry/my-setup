import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { log } from "./command";
import {
  expoEnvironmentValues,
  laravelEnvironmentValues,
  laravelTestingEnvironmentValues,
  verifyManagedExpoEnvironment,
  verifyManagedLaravelEnvironment,
} from "./environment";
import { readEnv } from "./files";
import { artisan, verifyDatabase, verifyHerd } from "./resources";
import type { ExpoEnvironmentOptions, LaravelEnvironmentOptions } from "./environment";
import type { ProjectEnvironmentContext } from "./types";

export function assertEnvironment(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function verifyFetch(
  url: string,
  label: string,
  headers: Record<string, string> = {},
  trustedCa?: string,
): Promise<void> {
  log("verify", `fetch ${label}: ${url}`);
  const args = ["--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}"];
  if (trustedCa) args.push("--cacert", trustedCa);
  for (const [name, value] of Object.entries(headers)) args.push("--header", `${name}: ${value}`);
  const response = spawnSync("curl", [...args, url], { encoding: "utf8" });
  if (response.error) throw response.error;
  assertEnvironment(response.status === 0, `${label} request failed: ${response.stderr.trim()}`);
  assertEnvironment(/^2\d\d$/.test(response.stdout), `${label} returned HTTP ${response.stdout}`);
}

export async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`${path} was not created within ${timeoutMs}ms`);
    }
    await Bun.sleep(250);
  }
}

export function verifyEnvironmentFile(path: string, expected: Record<string, string>): void {
  assertEnvironment(existsSync(path), `${path} is missing`);
  const environment = readEnv(path);
  for (const [key, value] of Object.entries(expected)) {
    assertEnvironment(environment[key] === value, `${key} does not belong to this lane`);
  }
}

export function verifyLaneInfrastructure(context: ProjectEnvironmentContext): void {
  assertEnvironment(new URL(context.appUrl).protocol === "https:", "lane APP_URL must use HTTPS");
  assertEnvironment(
    existsSync(context.herdCertificateAuthority),
    `Herd certificate authority is missing at ${context.herdCertificateAuthority}`,
  );
  verifyHerd(context);
  verifyDatabase(context);
}

export function verifyLaravelEnvironment(
  context: ProjectEnvironmentContext,
  options: LaravelEnvironmentOptions = {},
): void {
  verifyManagedLaravelEnvironment(context);
  verifyEnvironmentFile(
    resolve(context.backendDir, ".env"),
    laravelEnvironmentValues(context, options),
  );
  verifyEnvironmentFile(
    resolve(context.backendDir, ".env.testing"),
    laravelTestingEnvironmentValues(context),
  );
  artisan(context, "verify", ["about", "--only=environment"]);
  artisan(context, "verify", ["migrate:status"]);
}

export async function verifyViteDevelopmentServer(
  context: ProjectEnvironmentContext,
): Promise<void> {
  if (!shouldVerifyLiveServices()) {
    log("verify", "skipping live Vite verification for an available lane");
    return;
  }
  await verifyFetch(context.appUrl, "Herd HTTPS site", {}, context.herdCertificateAuthority);

  const hotPath = resolve(context.backendDir, "public/hot");
  await waitForFile(hotPath);
  const appUrl = new URL(context.appUrl);
  const viteOrigin = new URL(readFileSync(hotPath, "utf8").trim());
  verifyViteHotOrigin(context, viteOrigin, appUrl);
  await verifyFetch(
    new URL("/@vite/client", viteOrigin).toString(),
    "Vite client",
    {},
    context.herdCertificateAuthority,
  );
}

export function verifyViteHotOrigin(
  context: ProjectEnvironmentContext,
  viteOrigin: URL,
  appUrl = new URL(context.appUrl),
): void {
  assertEnvironment(viteOrigin.protocol === "https:", "Vite hot origin must use HTTPS");
  assertEnvironment(viteOrigin.hostname === appUrl.hostname, "Vite hot origin must use lane host");
  assertEnvironment(
    viteOrigin.port === context.vitePort,
    `Vite hot origin must use lane port ${context.vitePort}`,
  );
}

export function shouldVerifyLiveServices(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.PROJECT_LANE_VERIFY_LIVE_SERVICES !== "0";
}

export function verifyExpoEnvironmentFile(
  context: ProjectEnvironmentContext,
  options: ExpoEnvironmentOptions,
): void {
  verifyManagedExpoEnvironment(context);
  verifyEnvironmentFile(
    resolve(context.mobileDir, ".env.local"),
    expoEnvironmentValues(context, options),
  );
}
