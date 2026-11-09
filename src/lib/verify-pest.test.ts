import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunRecord } from "./verify-history";
import { KEPT_TESTS, parseTimingLines, readPestTimings, type TestTime } from "./verify-pest";
import { pestProfile, slowerTests } from "./verify-stats";

const DAY = 24 * 60 * 60 * 1000;
const line = (id: string, seconds: number) =>
  JSON.stringify({ id, file: "tests/A.php", name: id, seconds });

function run(id: string, daysAgo: number, slowest: TestTime[]): RunRecord {
  return {
    schema: 1,
    id,
    recordedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
    host: "main-mac",
    project: "awraq-project",
    branch: "b",
    source: "check",
    report: {
      version: 1,
      command: "signoff",
      head: "abc",
      base: null,
      mode: "signoff",
      areas: [],
      checks: [],
      seconds: 60,
      exitCode: 0,
      errors: [],
    },
    waits: {},
    pest: { tests: slowest.length, seconds: 1, slowest },
  };
}

const at = (seconds: number): TestTime => ({ file: "tests/A.php", name: "slow", seconds });

describe("pest timings", () => {
  test("keeps each test's first timing line", () => {
    expect(parseTimingLines(`${line("slow", 9)}\n${line("slow", 1)}\n`)).toEqual([at(9)]);
  });

  test("keeps only the slowest tests from a check run's log folder", () => {
    const logs = mkdtempSync(join(tmpdir(), "verify-pest-"));
    mkdirSync(join(logs, "test-timings"));
    writeFileSync(
      join(logs, "test-timings", "timings.jsonl"),
      Array.from({ length: KEPT_TESTS + 10 }, (_, index) => line(`t${index}`, index)).join("\n"),
    );
    const pest = readPestTimings(logs)!;

    expect(pest.tests).toBe(KEPT_TESTS + 10);
    expect(pest.slowest).toHaveLength(KEPT_TESTS);
    expect(pest.slowest[0]?.name).toBe(`t${KEPT_TESTS + 9}`);
    expect(readPestTimings(mkdtempSync(join(tmpdir(), "verify-pest-")))).toBeNull();
  });

  test("judges a test against its usual time and lists tests getting slower", () => {
    const runs = [
      run("1", 20, [at(1)]),
      run("2", 15, [at(1.1)]),
      run("3", 10, [at(0.9)]),
      run("now", 1, [at(2)]),
    ];

    expect(pestProfile(runs, runs.at(-1)!).tests[0]).toMatchObject({
      usual: { seconds: 1, samples: 3 },
      rating: "🔴",
    });
    expect(slowerTests(runs, "awraq-project", Date.now())).toEqual([
      { ...at(2), runs: 1, usual: 1, rating: "🔴" },
    ]);
  });
});
