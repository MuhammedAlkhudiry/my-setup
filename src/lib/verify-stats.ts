import type { CheckPlan, RunRecord } from "./verify-history";
import { type TestTime, testKey } from "./verify-pest";

export const DAY = 24 * 60 * 60 * 1000;
/** How far back "usual" looks, and the fewest samples it needs before it judges anything. */
export const USUAL_DAYS = 30;
const MIN_SAMPLES = 3;

export type Rating = "🔴" | "🟠" | "⚪" | "🟢" | "🌟";

export const at = (run: RunRecord) => Date.parse(run.recordedAt);
export const passed = (run: RunRecord) => run.report.exitCode === 0;
/** Steps the run actually executed, as opposed to passes reused from an earlier run on the same code. */
const ranSteps = (run: RunRecord) =>
  run.report.checks.filter((check) => !check.reused && check.status !== "skipped");

export function median(values: number[]): number | null {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Lower is better: how a duration compares with its usual one. */
function rateDuration(actual: number, usual: number | null, noise = 2): Rating {
  // Differences under `noise` seconds are noise, whatever their ratio.
  if (usual === null || Math.abs(actual - usual) < noise) return "⚪";

  const ratio = actual / usual;

  return ratio > 1.5
    ? "🔴"
    : ratio > 1.15
      ? "🟠"
      : ratio >= 0.85
        ? "⚪"
        : ratio >= 0.6
          ? "🟢"
          : "🌟";
}

/** Absolute bands, upper bounds in seconds: what a time is worth on its own, whatever it usually takes. */
const STEP_BANDS: [number, Rating][] = [
  [1, "🌟"],
  [5, "🟢"],
  [30, "⚪"],
  [120, "🟠"],
];
const RUN_BANDS: [number, Rating][] = [
  [60, "🌟"],
  [120, "🟢"],
  [240, "⚪"],
  [480, "🟠"],
];

const band = (bands: [number, Rating][], seconds: number): Rating =>
  bands.find(([limit]) => seconds < limit)?.[1] ?? "🔴";
/** One step's run time: under 1s 🌟, under 5s 🟢, up to 30s ⚪, up to 2m 🟠, longer 🔴. */
export const rateStepTime = (seconds: number) => band(STEP_BANDS, seconds);
/** A whole run's time: under 1m 🌟, under 2m 🟢, up to 4m ⚪, up to 8m 🟠, longer 🔴. */
export const rateRunTime = (seconds: number) => band(RUN_BANDS, seconds);

/** How much slower (positive) or faster than usual, as a fraction; null without a usual or within noise and 15%. */
export function changeVsUsual(actual: number, usual: number | null, noise = 2): number | null {
  if (!usual || Math.abs(actual - usual) < noise) return null;

  const change = actual / usual - 1;

  return Math.abs(change) < 0.15 ? null : change;
}

/** Higher is better: a pass rate against its usual rate. */
function ratePassRate(rate: number, usual: number | null): Rating {
  const reference = usual ?? 0.8;
  const delta = rate - reference;

  return rate < 0.5 || delta < -0.25
    ? "🔴"
    : delta < -0.1
      ? "🟠"
      : delta <= 0.05 || rate < 0.9
        ? "⚪"
        : rate >= 0.98
          ? "🌟"
          : "🟢";
}

export interface Usual {
  seconds: number | null;
  samples: number;
}

/**
 * The median time of passing runs of one command in one project over USUAL_DAYS before `before`. Runs that reused
 * every step are left out, since they measure the cache, not the checks.
 */
export function usualRun(
  runs: RunRecord[],
  project: string,
  command: string,
  before: number,
): Usual {
  const samples = runs
    .filter(
      (run) =>
        run.project === project &&
        run.report.command === command &&
        passed(run) &&
        at(run) < before &&
        before - at(run) < USUAL_DAYS * DAY &&
        ranSteps(run).length > 0,
    )
    .map((run) => run.report.seconds);

  return {
    seconds: samples.length >= MIN_SAMPLES ? median(samples) : null,
    samples: samples.length,
  };
}

/** The median run time (queue wait excluded) of one step's passing, executed runs in one project. */
function usualStep(
  runs: RunRecord[],
  project: string,
  task: string,
  before: number,
  exclude?: string,
): Usual {
  const samples: number[] = [];

  for (const run of runs) {
    if (
      run.project !== project ||
      run.id === exclude ||
      at(run) >= before ||
      before - at(run) >= USUAL_DAYS * DAY
    )
      continue;
    for (const check of run.report.checks)
      if (check.task === task && check.status === "passed" && !check.reused)
        samples.push(check.seconds);
  }

  return {
    seconds: samples.length >= MIN_SAMPLES ? median(samples) : null,
    samples: samples.length,
  };
}

export interface StepProfile {
  task: string;
  status: "passed" | "failed" | "skipped";
  reused: boolean;
  startedSeconds: number | null;
  ranSeconds: number;
  usual: Usual;
  /** The run time's absolute band (rateStepTime); reused and skipped steps are ⚪. */
  rating: Rating;
  /** Slower (positive) or faster than usual, when clearly so. */
  change: number | null;
  log: string | null;
}

export function profile(runs: RunRecord[], run: RunRecord) {
  const usual = usualRun(runs, run.project, run.report.command, at(run));
  const steps: StepProfile[] = run.report.checks.map((check) => {
    const ranSeconds = check.reused ? 0 : check.seconds;
    const stepUsual = usualStep(runs, run.project, check.task, at(run) + 1, run.id);

    return {
      task: check.task,
      status: check.status,
      reused: check.reused,
      startedSeconds: check.startedSeconds ?? null,
      ranSeconds,
      usual: stepUsual,
      rating: check.reused || check.status === "skipped" ? "⚪" : rateStepTime(ranSeconds),
      change: check.reused ? null : changeVsUsual(ranSeconds, stepUsual.seconds),
      log: check.log,
    };
  });

  // A run that reused every step measured the cache, not the checks, so it is never judged.
  const ran = ranSteps(run).length > 0;

  return {
    run,
    usual,
    rating: ran ? rateRunTime(run.report.seconds) : ("⚪" as Rating),
    change: ran ? changeVsUsual(run.report.seconds, usual.seconds) : null,
    steps,
  };
}

export type Profile = ReturnType<typeof profile>;

/** gate: a pull request's sign-off or check; full: a full run (`--full`, `--all`); nightly: the merge queue's nightly one. */
export type RunTier = "gate" | "full" | "nightly";
export const RUN_TIERS: RunTier[] = ["gate", "full", "nightly"];

export function runTier(run: RunRecord): RunTier {
  if (run.tag === "nightly") return "nightly";

  return run.report.mode === "full" || run.report.mode === "signoff-full" ? "full" : "gate";
}

/** full: a check only full runs add (fullChecks), whatever selected it this time; gate: one a change's areas select. */
export const stepTier = (plan: CheckPlan | null, task: string): "gate" | "full" =>
  plan?.full.includes(task) ? "full" : "gate";

export type Phase = "first" | "parallel" | "isolated" | "last";
const PHASES: Phase[] = ["first", "parallel", "isolated", "last"];

export interface PhaseStep extends StepProfile {
  tier: "gate" | "full";
}

export interface PhaseProfile {
  phase: Phase;
  steps: PhaseStep[];
  /** Wall time from the phase's first start to its last end, queue wait included. */
  seconds: number;
  /** The phase's share of the whole run. */
  share: number;
}

/** The most steps that ran at the same moment, for runs whose report predates `plan.jobs`. */
function peakConcurrency(steps: StepProfile[]): number {
  const edges = steps
    .filter((step) => step.startedSeconds !== null)
    .flatMap((step) => [
      [step.startedSeconds!, 1],
      [step.startedSeconds! + step.ranSeconds, -1],
    ])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  let running = 0;
  let peak = 0;

  for (const [, change] of edges) peak = Math.max(peak, (running += change!));

  return peak;
}

/** First start to last end; without start times, the one-by-one phases' summed length or the parallel one's longest. */
function phaseSeconds(phase: Phase, steps: StepProfile[]): number {
  if (steps.length && steps.every((step) => step.startedSeconds !== null))
    return (
      Math.max(...steps.map((step) => step.startedSeconds! + step.ranSeconds)) -
      Math.min(...steps.map((step) => step.startedSeconds!))
    );
  if (phase === "parallel") return Math.max(0, ...steps.map((step) => step.ranSeconds));

  return steps.reduce((sum, step) => sum + step.ranSeconds, 0);
}

/**
 * Groups a run's executed steps by the phase check.ts ran them in: the first ones in order, the rest `jobs` at a time,
 * then the isolated and last ones alone. The critical path is the shortest the run could be with unlimited parallel
 * slots: every one-by-one step plus the slowest parallel one.
 */
export function phaseProfile(item: Profile, plan: CheckPlan | null) {
  const ran = item.steps.filter((step) => !step.reused && step.status !== "skipped");
  const phaseOf = (task: string): Phase =>
    (["first", "isolated", "last"] as const).find((phase) => plan?.[phase].includes(task)) ??
    "parallel";
  const total = Math.max(item.run.report.seconds, 1);
  const phases: PhaseProfile[] = PHASES.map((phase) => {
    const steps = ran
      .filter((step) => phaseOf(step.task) === phase)
      .map((step) => ({ ...step, tier: stepTier(plan, step.task) }));
    const seconds = phaseSeconds(phase, steps);

    return { phase, steps, seconds, share: seconds / total };
  });
  const parallel = phases[1]!;
  const jobs = Math.min(plan?.jobs ?? peakConcurrency(parallel.steps), parallel.steps.length);
  const busy = parallel.steps.reduce((sum, step) => sum + step.ranSeconds, 0);
  const sum = (steps: StepProfile[]) => steps.reduce((total, step) => total + step.ranSeconds, 0);

  return {
    plan: Boolean(plan),
    phases,
    /** The run's parallel slots; null when its report predates them, so `slots` is the most that ran at once. */
    jobs: plan?.jobs ?? null,
    slots: jobs,
    /** How busy the parallel slots were: their summed run time over slots × the phase's wall time. */
    efficiency: jobs && parallel.seconds ? busy / (jobs * parallel.seconds) : null,
    criticalPath:
      sum(phases[0]!.steps) +
      Math.max(0, ...parallel.steps.map((step) => step.ranSeconds)) +
      sum(phases[2]!.steps) +
      sum(phases[3]!.steps),
    /** Run time outside the phases: setup, formatting, and finishing. */
    otherSeconds: Math.max(0, item.run.report.seconds - phases.reduce((t, p) => t + p.seconds, 0)),
  };
}

export interface RepeatingFailure {
  project: string;
  task: string;
  failures: number;
  runs: number;
  branches: number;
  lastAt: string;
  lastBranch: string | null;
  rating: Rating;
}

/**
 * Steps and runner errors that failed more than once over `days`, with how many runs executed them and on how many
 * branches they failed. Failing on several branches points at a flaky check or a broken main, not one branch's bug.
 */
export function repeatingFailures(runs: RunRecord[], now: number, days = 7): RepeatingFailure[] {
  const items = new Map<string, RepeatingFailure & { branchSet: Set<string> }>();

  for (const run of runs) {
    if (now - at(run) >= days * DAY || run.report.command === "pre-push") continue;

    const outcomes = [
      ...ranSteps(run).map((check) => ({ task: check.task, failed: check.status === "failed" })),
      ...run.report.errors.map((error) => ({ task: error.item, failed: true })),
    ];
    for (const outcome of outcomes) {
      const key = `${run.project}\0${outcome.task}`;
      const item =
        items.get(key) ??
        ({
          project: run.project,
          task: outcome.task,
          failures: 0,
          runs: 0,
          branches: 0,
          lastAt: "",
          lastBranch: null,
          rating: "⚪",
          branchSet: new Set<string>(),
        } as RepeatingFailure & { branchSet: Set<string> });
      item.runs++;
      if (outcome.failed) {
        item.failures++;
        item.branchSet.add(run.branch ?? run.report.head ?? run.id);
        item.lastAt = run.recordedAt;
        item.lastBranch = run.branch;
      }
      items.set(key, item);
    }
  }

  return [...items.values()]
    .filter((item) => item.failures >= 2)
    .map(({ branchSet, ...item }) => ({
      ...item,
      branches: branchSet.size,
      rating: (branchSet.size >= 3 ? "🔴" : branchSet.size === 2 ? "🟠" : "⚪") as Rating,
    }))
    .sort((a, b) => b.branches - a.branches || b.failures - a.failures);
}

export interface TrendDay {
  day: string;
  runs: number;
  passRate: number | null;
  passRating: Rating;
  medianSeconds: number | null;
  timeRating: Rating;
}

/** One row per local day for the last `days` days of one command in one project, judged against the last 30 days, those days included. */
export function trend(runs: RunRecord[], project: string, command: string, now: number, days = 7) {
  const mine = runs.filter((run) => run.project === project && run.report.command === command);
  const baseline = mine.filter((run) => now - at(run) < USUAL_DAYS * DAY);
  const usualPass = baseline.length ? baseline.filter(passed).length / baseline.length : null;
  const usualTime = median(
    baseline.filter((run) => passed(run) && ranSteps(run).length).map((run) => run.report.seconds),
  );
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const rows: TrendDay[] = [];

  for (let offset = days - 1; offset >= 0; offset--) {
    const start = today.getTime() - offset * DAY;
    const dayRuns = mine.filter((run) => at(run) >= start && at(run) < start + DAY);
    const passRate = dayRuns.length ? dayRuns.filter(passed).length / dayRuns.length : null;
    const medianSeconds = median(
      dayRuns.filter((run) => passed(run) && ranSteps(run).length).map((run) => run.report.seconds),
    );
    rows.push({
      day: new Date(start).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
      }),
      runs: dayRuns.length,
      passRate,
      passRating: passRate === null ? "⚪" : ratePassRate(passRate, usualPass),
      medianSeconds,
      timeRating: medianSeconds === null ? "⚪" : rateDuration(medianSeconds, usualTime),
    });
  }

  return { rows, usualPass, usualTime, baselineRuns: baseline.length };
}

export interface SlowStep {
  project: string;
  task: string;
  medianSeconds: number;
  runs: number;
  /** The share of executed sign-offs this step ran in. */
  share: number;
}

/** The steps that cost the most time per sign-off over `days`, by median run time across runs that executed them. */
export function slowSteps(runs: RunRecord[], project: string, now: number, days = 7): SlowStep[] {
  const signoffs = runs.filter(
    (run) =>
      run.project === project && run.report.command === "signoff" && now - at(run) < days * DAY,
  );
  const byTask = new Map<string, number[]>();

  for (const run of signoffs)
    for (const check of ranSteps(run)) {
      const ran = byTask.get(check.task) ?? [];
      ran.push(check.seconds);
      byTask.set(check.task, ran);
    }

  return [...byTask.entries()]
    .map(([task, ran]) => ({
      project,
      task,
      medianSeconds: median(ran)!,
      runs: ran.length,
      share: signoffs.length ? ran.length / signoffs.length : 0,
    }))
    .sort((a, b) => b.medianSeconds - a.medianSeconds);
}

/** A test's time differences under this many seconds are noise, whatever their ratio. */
const TEST_NOISE = 0.25;

/**
 * The median time of one test over USUAL_DAYS before `before`. Runs keep only their slowest tests, so a test that was
 * fast before has no samples there: it shows as new rather than as slower.
 */
function usualTest(
  runs: RunRecord[],
  project: string,
  key: string,
  from: number,
  to: number,
): Usual {
  const samples: number[] = [];

  for (const run of runs)
    if (run.project === project && run.pest && at(run) >= from && at(run) < to)
      for (const test of run.pest.slowest) if (testKey(test) === key) samples.push(test.seconds);

  return {
    seconds: samples.length >= MIN_SAMPLES ? median(samples) : null,
    samples: samples.length,
  };
}

export interface TestProfile extends TestTime {
  usual: Usual;
  rating: Rating;
}

/** One run's slowest tests, each judged against its own usual time. */
export function pestProfile(runs: RunRecord[], run: RunRecord) {
  const tests: TestProfile[] = (run.pest?.slowest ?? []).map((test) => {
    const usual = usualTest(runs, run.project, testKey(test), at(run) - USUAL_DAYS * DAY, at(run));

    return { ...test, usual, rating: rateDuration(test.seconds, usual.seconds, TEST_NOISE) };
  });

  return { run, pest: run.pest!, tests };
}

export interface SlowerTest extends TestTime {
  runs: number;
  usual: number;
  rating: Rating;
}

/** Tests whose median over the last `days` is clearly above their median over the USUAL_DAYS before that window. */
export function slowerTests(
  runs: RunRecord[],
  project: string,
  now: number,
  days = 7,
): SlowerTest[] {
  const start = now - days * DAY;
  const recent = new Map<string, { test: TestTime; times: number[] }>();

  for (const run of runs)
    if (run.project === project && run.pest && at(run) >= start && at(run) <= now)
      for (const test of run.pest.slowest) {
        const entry = recent.get(testKey(test)) ?? { test, times: [] };
        entry.times.push(test.seconds);
        recent.set(testKey(test), entry);
      }

  return [...recent.entries()]
    .flatMap(([key, { test, times }]) => {
      const usual = usualTest(runs, project, key, start - USUAL_DAYS * DAY, start).seconds;
      const recentSeconds = median(times)!;
      const rating = rateDuration(recentSeconds, usual, TEST_NOISE);

      return usual !== null && (rating === "🔴" || rating === "🟠")
        ? [{ ...test, seconds: recentSeconds, runs: times.length, usual, rating }]
        : [];
    })
    .sort((a, b) => b.seconds - b.usual - (a.seconds - a.usual));
}
