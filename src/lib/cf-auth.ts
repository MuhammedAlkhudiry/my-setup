import { dlopen } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { execa, type Result } from "execa";

// `cf` refreshes its OAuth token only once the stored expiry has passed, with no margin and no
// lock between processes. A call in the token's last seconds reaches Cloudflare after the token
// has expired there, and processes crossing the expiry together all refresh with the same
// refresh token, so the token one of them already holds is revoked. Both fail as
// `[10000] Authentication error`; a call made after the refresh lands succeeds.
export const CF_CONFIG = join(homedir(), "Library/Preferences/cloudflare/config/default.json");
export const EXPIRY_MARGIN_MS = 15_000;
const LOCK_PATH = join(homedir(), ".local", "state", "share-html", "cf-auth.lock");

const {
  symbols: { flock },
} = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: ["i32", "i32"], returns: "i32" },
});

export type CfResult = Result<{ reject: false }>;

export interface CfDeps {
  exec: (args: string[]) => Promise<CfResult>;
  expiresAt: () => number | undefined;
  withLock: <T>(task: () => Promise<T>) => Promise<T>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
}

export const isCfAuthError = (stderr: unknown) =>
  typeof stderr === "string" && /\b10000\b|Authentication error/i.test(stderr);

/** When the stored OAuth token expires; reads only the expiry, never the token. */
export function cfTokenExpiresAt(path = CF_CONFIG): number | undefined {
  try {
    const { expiration_time } = JSON.parse(readFileSync(path, "utf8")) as {
      expiration_time?: string;
    };
    const expiry = expiration_time ? Date.parse(expiration_time) : NaN;
    return Number.isNaN(expiry) ? undefined : expiry;
  } catch {
    return undefined;
  }
}

/** Why `cf` cannot refresh its own sign-in, for doctor; undefined when it can. */
export function cfAuthProblem(path = CF_CONFIG): string | undefined {
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!config.refresh_token) return `${path} has no refresh token; run cf auth login`;
    if (cfTokenExpiresAt(path) === undefined)
      return `${path} has no token expiry; run cf auth login`;
    return undefined;
  } catch {
    return `${path} is missing or unreadable; run cf auth login`;
  }
}

/** Holds a kernel lock that every share-html process shares; a crash releases it. */
async function withCfAuthLock<T>(task: () => Promise<T>): Promise<T> {
  mkdirSync(join(LOCK_PATH, ".."), { recursive: true, mode: 0o700 });
  const fd = openSync(LOCK_PATH, "a", 0o600);
  try {
    while (flock(fd, 2 | 4) !== 0) await Bun.sleep(50 + Math.floor(Math.random() * 100));
    return await task();
  } finally {
    flock(fd, 8);
    closeSync(fd);
  }
}

const defaultDeps: CfDeps = {
  // A neutral cwd keeps a project's Cloudflare config from redirecting the call.
  exec: (args) => execa("cf", args, { cwd: tmpdir(), reject: false }),
  expiresAt: () => cfTokenExpiresAt(),
  withLock: withCfAuthLock,
  sleep: Bun.sleep,
  now: Date.now,
};

/**
 * Runs `cf` so its OAuth refresh happens once, in one process: near the expiry the call waits
 * under a lock until `cf` will refresh, and an authentication failure is retried once the same way.
 */
export async function runCf(
  args: string[],
  options: { reject?: boolean } = {},
  deps: CfDeps = defaultDeps,
): Promise<CfResult> {
  const call = () => deps.exec(args);
  const nearExpiry = () => {
    const expiry = deps.expiresAt();
    return expiry !== undefined && expiry - deps.now() < EXPIRY_MARGIN_MS;
  };
  const afterRefresh = (settleMs: number) =>
    deps.withLock(async () => {
      // Another process may have refreshed while this one waited for the lock.
      const expiry = deps.expiresAt();
      const untilExpired = expiry === undefined ? 0 : expiry - deps.now();
      if (untilExpired > 0 && untilExpired < EXPIRY_MARGIN_MS)
        await deps.sleep(untilExpired + 1000);
      else if (settleMs) await deps.sleep(settleMs);
      return call();
    });

  let result = nearExpiry() ? await afterRefresh(0) : await call();
  // A token revoked by another process's refresh fails with a later expiry; let that write land.
  if (result.failed && isCfAuthError(result.stderr)) result = await afterRefresh(1000);

  if (result.failed && options.reject !== false) throw result;
  return result;
}
