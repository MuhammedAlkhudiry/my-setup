import { expect, test } from "bun:test";
import {
  admitSignoff,
  candidateSignoff,
  signoffDiagnostics,
  signoffPolicy,
} from "./merge-queue-signoff";

test("admission waits below the configured threshold, serializes gates, and bounds waiting", async () => {
  let time = 0;
  let load = 20;
  let released = false;
  let pauses = 0;
  const admitted = await admitSignoff({
    maxLoad: 20,
    waitSeconds: 3600,
    now: () => time,
    readLoad: () => load,
    lock: () =>
      pauses
        ? () => {
            released = true;
          }
        : undefined,
    log: async () => {},
    pause: async (ms) => {
      time += ms;
      if (++pauses === 2) load = 19;
    },
  });
  expect(pauses).toBe(2);
  expect(admitted.load).toBe(19);
  admitted.release();
  expect(released).toBe(true);
  await expect(
    admitSignoff({
      maxLoad: 20,
      waitSeconds: 1,
      now: () => time,
      readLoad: () => 100,
      lock: () => () => {},
      log: async () => {},
      pause: async (ms) => {
        time += ms;
      },
    }),
  ).rejects.toThrow("admission timed out");
  expect(
    signoffPolicy({
      MERGE_QUEUE_MAX_LOAD: "12",
      MERGE_QUEUE_WAIT_SECONDS: "60",
    }),
  ).toEqual({
    maxLoad: 12,
    waitSeconds: 60,
  });
  expect(() => signoffPolicy({ MERGE_QUEUE_MAX_LOAD: "NaN" })).toThrow(
    "invalid merge queue",
  );
});

test("nested stage logs explain an all-passing PHP suite rejected by timing or coverage", async () => {
  const logs = new Map([
    ["/gate.log", "FAIL family-tree:pest log=/stage.log"],
    ["/stage.log", "heavy-run: failed; log: /php.log"],
    [
      "/php.log",
      "Tests: 3616 passed (9712 assertions)\n::error title=PHP test timing regression::6.5s exceeds 5.00s: example test",
    ],
  ]);
  const result = await signoffDiagnostics(
    "heavy-run: failed; log: /gate.log",
    "/fallback.log",
    async (path) => logs.get(path)!,
  );
  expect(result.transient).toBe(true);
  expect(result.failures).toEqual([
    {
      name: "family-tree:pest",
      log: "/stage.log",
      reason: expect.stringContaining("slow-test budget"),
      budgetOnly: true,
    },
  ]);
  expect(result.failures[0]!.reason).toContain("3616 passed");
  expect(result.failures[0]!.reason).toContain("6.5s exceeds 5.00s");
  const coverage = await signoffDiagnostics(
    "FAIL family-tree:pest log=/coverage.log",
    "/gate",
    async () => "Tests: 3616 passed\nCoverage 76% below minimum threshold 80%",
  );
  expect(coverage.failures[0]!.reason).toContain("coverage gate");
  expect(coverage.transient).toBe(false);
});

test("timeout retry succeeds without reconstructing the candidate; deterministic cold failures do not retry", async () => {
  const attempts: number[] = [];
  const lines: string[] = [];
  const result = await candidateSignoff({
    runLog: "/candidate.log",
    admission: { readLoad: () => 1, lock: () => () => {} },
    log: async (line) => {
      lines.push(line);
    },
    requireClean: async () => {},
    readLog: async () => "Exceeded timeout of 5000 ms",
    run: async (attempt) => {
      attempts.push(attempt);
      return { ok: attempt === 2, output: "FAIL mobile:test log=/mobile.log" };
    },
  });
  expect(result.ok).toBe(true);
  expect(attempts).toEqual([1, 2]);
  expect(result.runs[0]!.failures[0]!.name).toBe("mobile:test");
  expect(lines.some((line) => line.includes("run 1 start: load=1.00"))).toBe(
    true,
  );
  expect(lines.some((line) => line.includes("run 2 end: load=1.00"))).toBe(
    true,
  );
  let count = 0;
  const failed = await candidateSignoff({
    runLog: "/candidate.log",
    admission: { readLoad: () => 1, lock: () => () => {} },
    log: async () => {},
    requireClean: async () => {},
    readLog: async () => "Expected 1, received 2",
    run: async () => {
      count++;
      return { ok: false, output: "FAIL mobile:test log=/mobile.log" };
    },
  });
  expect(failed.ok).toBe(false);
  expect(count).toBe(1);
});

test("high-load failure retries once and retains both failing stages and logs", async () => {
  const loads = [1, 100, 2, 3];
  const result = await candidateSignoff({
    runLog: "/candidate.log",
    admission: { readLoad: () => loads.shift()!, lock: () => () => {} },
    log: async () => {},
    requireClean: async () => {},
    readLog: async () => "assertion failed",
    run: async (attempt) => ({
      ok: false,
      output: `FAIL stage-${attempt} log=/stage-${attempt}.log`,
      log: `/run-${attempt}.log`,
    }),
  });
  expect(result.ok).toBe(false);
  expect(
    result.runs.map((run) => [
      run.attempt,
      run.log,
      run.failures[0]!.name,
      run.failures[0]!.log,
    ]),
  ).toEqual([
    [1, "/run-1.log", "stage-1", "/stage-1.log"],
    [2, "/run-2.log", "stage-2", "/stage-2.log"],
  ]);
  expect(result.runs[0]!.endLoad).toBe(100);
});

test("a batch whose only failure is the per-test timing budget lands with a warning", async () => {
  const logs: Record<string, string> = {
    "/slow.log":
      "Tests:    3619 passed (9712 assertions)\n::error title=PHP test timing regression::7.1s exceeds 5.00s: a test",
    "/broken.log":
      "Tests:    1 failed, 3618 passed\n::error title=PHP test timing regression::7.1s exceeds 5.00s: a test",
  };
  const sign = (log: string) =>
    candidateSignoff({
      runLog: "/candidate.log",
      admission: { readLoad: () => 1, lock: () => () => {} },
      log: async () => {},
      requireClean: async () => {},
      readLog: async (path) => logs[path]!,
      run: async () => ({
        ok: false,
        output: `FAIL family-tree:pest log=${log}`,
      }),
    });
  const slow = await sign("/slow.log");
  expect(slow.ok).toBe(true);
  expect(slow.runs).toHaveLength(1);
  expect(slow.runs[0]!.warning).toContain("slow-test budget only");
  expect((await sign("/broken.log")).ok).toBe(false);
});
