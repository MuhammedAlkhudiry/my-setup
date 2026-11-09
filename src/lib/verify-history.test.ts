import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CheckReport,
  historyPath,
  parseHistory,
  readHistory,
  recordRun,
  type RunRecord,
  trimHistory,
} from "./verify-history";
import {
  changeVsUsual,
  phaseProfile,
  profile,
  rateRunTime,
  rateStepTime,
  repeatingFailures,
  runTier,
  trend,
  usualRun,
} from "./verify-stats";

const DAY = 24 * 60 * 60 * 1000;

function report(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    version: 1,
    command: "signoff",
    head: "abc1234567",
    base: null,
    mode: "signoff",
    areas: ["backend"],
    checks: [
      {
        task: "backend:test",
        status: "passed",
        seconds: 100,
        reused: false,
        log: "/tmp/a.log",
        startedSeconds: 1,
      },
      { task: "lint", status: "passed", seconds: 0, reused: true, log: null },
    ],
    seconds: 101,
    exitCode: 0,
    errors: [],
    ...overrides,
  };
}

function run(
  id: string,
  daysAgo: number,
  overrides: Partial<CheckReport> = {},
  extra: Partial<RunRecord> = {},
): RunRecord {
  return {
    schema: 1,
    id,
    recordedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
    host: "main-mac",
    project: "harium-project",
    branch: `branch-${id}`,
    source: "check",
    report: report(overrides),
    waits: {},
    ...extra,
  };
}

function repo(origin: string): string {
  const folder = mkdtempSync(join(tmpdir(), "verify-repo-"));
  spawnSync("git", ["init", "-q", "-b", "feature"], { cwd: folder });
  spawnSync("git", ["remote", "add", "origin", origin], { cwd: folder });

  return folder;
}

describe("recording", () => {
  test("stores a GitHub checkout's run with its branch and drops passed steps' logs", () => {
    const directory = mkdtempSync(join(tmpdir(), "verify-state-"));
    const stored = recordRun(report(), repo("git@github.com:owner/harium-project.git"), {
      directory,
    });

    expect(stored?.project).toBe("harium-project");
    expect(stored?.branch).toBe("feature");
    const [saved] = readHistory(directory).runs;
    expect(saved?.report.checks[0]?.log).toBeNull();
    expect(saved?.id).toBe(stored!.id);
  });

  test("tags the merge queue's nightly sign-off", () => {
    const directory = mkdtempSync(join(tmpdir(), "verify-state-"));
    const origin = repo("git@github.com:owner/harium-project.git");
    const nightly = recordRun(report({ mode: "signoff-full" }), origin, {
      directory,
      tag: "nightly",
    })!;

    expect(nightly.tag).toBe("nightly");
    expect(runTier(nightly)).toBe("nightly");
    expect(
      runTier(recordRun(report({ mode: "signoff-full" }), origin, { directory })!),
    ).toBe("full");
    expect(runTier(recordRun(report(), origin, { directory })!)).toBe("gate");
  });

  test("skips checkouts without a GitHub origin, such as check.ts's test repositories", () => {
    const directory = mkdtempSync(join(tmpdir(), "verify-state-"));

    expect(recordRun(report(), repo("/tmp/origin.git"), { directory })).toBeNull();
  });

  test("refuses report versions it does not know and drops duplicates", () => {
    const known = run("a", 0);
    const future = { ...run("b", 0), report: { ...report(), version: 2 } };
    const history = parseHistory([known, known, future].map((r) => JSON.stringify(r)).join("\n"));

    expect(history.runs.map((r) => r.id)).toEqual(["a"]);
    expect(history.refused).toEqual({ "2": 1 });
  });

  test("trims runs older than the kept window", () => {
    const directory = mkdtempSync(join(tmpdir(), "verify-state-"));
    writeFileSync(
      historyPath(directory),
      [run("old", 400), run("new", 1)].map((r) => `${JSON.stringify(r)}\n`).join(""),
    );
    trimHistory(directory);

    expect(readFileSync(historyPath(directory), "utf8")).not.toContain('"old"');
    expect(readHistory(directory).runs.map((r) => r.id)).toEqual(["new"]);
  });

});

describe("stats", () => {
  test("judges a run and its steps against the usual of earlier passing runs", () => {
    const runs = [
      run("1", 3),
      run("2", 2),
      run("3", 1),
      run(
        "now",
        0,
        {
          seconds: 200,
          checks: [
            {
              task: "backend:test",
              status: "passed",
              seconds: 190,
              reused: false,
              log: null,
              startedSeconds: 1,
            },
          ],
        },
        { waits: { "backend:test": 40 } },
      ),
    ];
    const result = profile(runs, runs.at(-1)!);

    expect(result.usual).toEqual({ seconds: 101, samples: 3 });
    // Ratings are absolute bands; the usual shows as a change: 200s is ⚪ for a run, 150s 🔴 for one step.
    expect(result).toMatchObject({ rating: "⚪", change: 200 / 101 - 1 });
    expect(result.steps[0]).toMatchObject({
      waitSeconds: 40,
      ranSeconds: 150,
      rating: "🔴",
      change: 0.5,
    });
  });

  test("rates times by absolute bands and reports only clear changes against usual", () => {
    expect([0.5, 3, 20, 33, 59, 150].map(rateStepTime)).toEqual([
      "🌟",
      "🟢",
      "⚪",
      "🟠",
      "🟠",
      "🔴",
    ]);
    expect([45, 100, 200, 300, 600].map(rateRunTime)).toEqual(["🌟", "🟢", "⚪", "🟠", "🔴"]);
    expect(changeVsUsual(33, 33)).toBeNull();
    expect(changeVsUsual(33, 30)).toBeNull();
    expect(changeVsUsual(42, 30)).toBeCloseTo(0.4);
    expect(changeVsUsual(2.5, 1)).toBeNull();
    expect(changeVsUsual(10, null)).toBeNull();
  });

  test("leaves runs that reused every step out of the usual time", () => {
    const reusedOnly = {
      checks: [{ task: "lint", status: "passed" as const, seconds: 0, reused: true, log: null }],
      seconds: 2,
    };
    const runs = [run("1", 1, reusedOnly), run("2", 1, reusedOnly), run("3", 1, reusedOnly)];

    expect(usualRun(runs, "harium-project", "signoff", Date.now()).seconds).toBeNull();
  });

  test("ranks failures that repeat across branches first", () => {
    const failing = {
      exitCode: 1,
      checks: [
        { task: "backend:test", status: "failed" as const, seconds: 5, reused: false, log: "/l" },
      ],
    };
    const runs = [run("a", 1, failing), run("b", 1, failing), run("c", 1, failing), run("d", 1)];
    const [failure] = repeatingFailures(runs, Date.now());

    expect(failure).toMatchObject({
      task: "backend:test",
      failures: 3,
      runs: 4,
      branches: 3,
      rating: "🔴",
    });
  });

  test("groups a run's steps by the phase its schedule ran them in", () => {
    const step = (task: string, startedSeconds: number, seconds: number) => ({
      task,
      status: "passed" as const,
      seconds,
      reused: false,
      log: null,
      startedSeconds,
    });
    const item = profile(
      [],
      run("now", 0, {
        seconds: 100,
        checks: [
          step("lint", 0, 10),
          step("unit", 10, 40),
          step("types", 10, 20),
          step("browser", 50, 30),
          step("images", 80, 15),
        ],
      }),
    );
    const view = phaseProfile(item, {
      jobs: 2,
      first: ["lint"],
      isolated: ["browser", "images"],
      last: [],
      full: ["images"],
    });

    expect(view.phases.map((phase) => [phase.phase, phase.seconds, phase.steps.length])).toEqual([
      ["first", 10, 1],
      ["parallel", 40, 2],
      ["isolated", 45, 2],
      ["last", 0, 0],
    ]);
    expect(view.phases[2]!.steps.map((item) => item.tier)).toEqual(["gate", "full"]);
    // Two slots for 40s held 60s of work.
    expect(view.efficiency).toBe(0.75);
    expect(view.criticalPath).toBe(10 + 40 + 30 + 15);
    expect(view.otherSeconds).toBe(5);
    // Without a schedule's jobs, the slots are the most steps that ran at once.
    expect(phaseProfile(item, { first: ["lint"], isolated: [], last: [], full: [] }).slots).toBe(2);
  });

  test("builds one trend row per day", () => {
    const rows = trend(
      [run("a", 0), run("b", 0, { exitCode: 1 })],
      "harium-project",
      "signoff",
      Date.now(),
    ).rows;

    expect(rows).toHaveLength(7);
    expect(rows.at(-1)).toMatchObject({ runs: 2, passRate: 0.5 });
  });
});
