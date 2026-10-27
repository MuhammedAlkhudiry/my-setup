import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  cfAuthProblem,
  cfTokenExpiresAt,
  type CfDeps,
  type CfResult,
  EXPIRY_MARGIN_MS,
  runCf,
} from "./cf-auth";

const AUTH_ERROR = "✘ [10000] Authentication error";

function fakeCf(outcomes: Array<"ok" | "auth" | "other">, expiresIn = 60 * 60 * 1000) {
  let clock = 1_000_000;
  const expiry = clock + expiresIn;
  const log: string[] = [];
  let locked = false;

  const deps: CfDeps = {
    exec: async () => {
      const outcome = outcomes.shift() ?? "ok";
      log.push(`${outcome}${locked ? " locked" : ""} at ${clock - expiry}`);
      return (outcome === "ok"
        ? { failed: false, exitCode: 0, stdout: "done", stderr: "" }
        : {
            failed: true,
            exitCode: 1,
            stdout: "",
            stderr: outcome === "auth" ? AUTH_ERROR : "✘ [10007] does not exist",
          }) as unknown as CfResult;
    },
    expiresAt: () => expiry,
    withLock: async (task) => {
      locked = true;
      try {
        return await task();
      } finally {
        locked = false;
      }
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, log };
}

describe("runCf", () => {
  test("retries an authentication error once, alone under the lock", async () => {
    const { deps, log } = fakeCf(["auth", "ok"]);

    expect((await runCf(["r2", "objects", "get"], {}, deps)).stdout).toBe("done");
    expect(log).toEqual(["auth at -3600000", "ok locked at -3599000"]);
  });

  test("near the expiry, waits under the lock until cf will refresh", async () => {
    const { deps, log } = fakeCf(["ok"], EXPIRY_MARGIN_MS - 5000);

    await runCf(["r2", "objects", "put"], {}, deps);
    expect(log).toEqual(["ok locked at 1000"]);
  });

  test("throws a second authentication error and never retries other failures", async () => {
    const twice = fakeCf(["auth", "auth"]);
    expect(runCf(["r2", "objects", "get"], {}, twice.deps)).rejects.toMatchObject({
      stderr: AUTH_ERROR,
    });
    await Bun.sleep(5);
    expect(twice.log).toHaveLength(2);

    const missing = fakeCf(["other"]);
    const result = await runCf(["r2", "objects", "get"], { reject: false }, missing.deps);
    expect(result.failed).toBe(true);
    expect(missing.log).toHaveLength(1);
  });
});

describe("cf sign-in file", () => {
  test("reads the expiry and reports a sign-in cf cannot refresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "my-setup-cf-auth-"));
    const path = join(dir, "default.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ refresh_token: "r", expiration_time: "2026-10-23T07:37:26.988Z" }),
      );
      expect(cfTokenExpiresAt(path)).toBe(Date.parse("2026-10-23T07:37:26.988Z"));
      expect(cfAuthProblem(path)).toBeUndefined();

      await writeFile(path, JSON.stringify({ expiration_time: "2026-10-23T07:37:26.988Z" }));
      expect(cfAuthProblem(path)).toContain("no refresh token");

      expect(cfAuthProblem(join(dir, "missing.json"))).toContain("cf auth login");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
