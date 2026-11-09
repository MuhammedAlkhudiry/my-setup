#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

import pc from "picocolors";

import { readSetupMirrors } from "../lib/device";
import {
  canonicalPlan,
  type CheckPlan,
  type CheckReport,
  historyPath,
  KNOWN_REPORT_VERSIONS,
  projectOf,
  pullSpareHosts,
  readHistory,
  recordRun,
  type RunRecord,
  shortHost,
} from "../lib/verify-history";
import {
  at,
  changeVsUsual,
  DAY,
  passed,
  type Profile,
  pestProfile,
  phaseProfile,
  profile,
  type Rating,
  rateStepTime,
  repeatingFailures,
  RUN_TIERS,
  type RunTier,
  runTier,
  stepTier,
  slowerTests,
  slowSteps,
  trend,
  USUAL_DAYS,
} from "../lib/verify-stats";

const help = `Usage: verify [command] [--project <name>] [--days <n>] [--tier <tier>] [--verbose] [--json] [--no-pull]

Your verification history at a glance: sign-offs, their speed, slow steps, and failures.

  verify                         the dashboard for this repo, or every project outside one
  verify profile [<n>|<sha>]     each project's last run by phase (first, parallel, alone, last) with each phase's time,
                                 share, and the critical path; or the nth from \`verify runs\`, or one by commit
  verify signoff [--local] [--full]
                                 sign off the pushed branch head on the least-loaded spare Mac, posting the
                                 \`signoff\` status as mise run signoff does; runs here only when none is reachable (--help)
  verify profile --run [check|signoff|premerge] [-- <args>]
                                 run this checkout's mise task for real (default check), then show its timeline
  verify profile pest [<n>|<sha>]
                                 the slowest Pest tests of each project's last run that ran Pest (or a chosen run),
                                 each against its usual time, then tests getting slower over the last --days
  verify runs                    recent runs, numbered for \`verify profile <n>\`
  verify steps                   the slowest sign-off steps over the last --days (default 7), each tagged gate or full
  verify trend                   sign-offs per day over the last --days (default 7)
  --tier gate|full|nightly       with runs, steps, and trend: count only pull-request runs, full runs (--full, --all),
                                 or the merge queue's nightly full sign-off of main
  verify failures                steps that failed more than once over the last --days (default 7)

Ratings: 🌟 very good · 🟢 good · ⚪ normal · 🟠 bad · 🔴 very bad.
  A step's time:   under 1s 🌟 · under 5s 🟢 · 5–30s ⚪ · 30s–2m 🟠 · over 2m 🔴
  A run's time:    under 1m 🌟 · under 2m 🟢 · 2–4m ⚪ · 4–8m 🟠 · over 8m 🔴
  "+40% vs usual" marks a time clearly slower than the median of the last ${USUAL_DAYS} days (15% and 2s or more).
Profile: "took" is a phase's wall time, host-queue wait included; a step's excludes it. "slots N% used" is the parallel
  steps' run time over slots × the phase's time ("N* at once" when an older report leaves N to the most steps seen at
  once). The critical path is every one-by-one step plus the slowest parallel one: the run's floor with unlimited slots.
  --verbose also lists the reused steps.
History: ${historyPath().replace(homedir(), "~")} (check.ts records every run; spare Macs are pulled over SSH).`;

const rawArgs = process.argv.slice(2);
// Sign-off options belong to `mise run signoff`, so it parses its own arguments.
if (rawArgs[0] === "signoff")
  process.exit(await (await import("./verify-signoff")).verifySignoff(rawArgs.slice(1)));
const flags = {
  json: false,
  pull: true,
  project: undefined as string | undefined,
  days: 7,
  limit: 20,
  /** The mise task `profile --run` runs, when given. */
  run: undefined as string | undefined,
  /** Lists every step, reused step, and area instead of a count. */
  verbose: false,
  /** Counts only runs of this tier in `steps`, `trend`, and `runs`. */
  tier: undefined as RunTier | undefined,
};
const RUN_TASKS = ["check", "signoff", "premerge"];
const positional: string[] = [];
const passthrough: string[] = [];

// Accept `--project=harium` as well as `--project harium`.
const args = rawArgs.flatMap((arg) =>
  /^--(project|days|limit|run|tier)=/.test(arg)
    ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
    : [arg],
);

for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;

  if (arg === "--") {
    passthrough.push(...args.slice(index + 1));
    break;
  } else if (arg === "--json") flags.json = true;
  else if (arg === "--no-pull") flags.pull = false;
  else if (arg === "--verbose" || arg === "-v") flags.verbose = true;
  else if (arg === "--run") {
    // The task is optional: `--run` alone runs the light gate.
    const next = args[index + 1];
    if (
      next &&
      !next.startsWith("-") &&
      !RUN_TASKS.includes(next) &&
      !/^\d+$|^[0-9a-f]{4,}$/.test(next)
    )
      fail(`--run takes check, signoff, or premerge, not ${next}`, 2);
    flags.run = next && RUN_TASKS.includes(next) ? args[++index] : "check";
  } else if (arg === "--project") flags.project = args[++index];
  else if (arg === "--tier") {
    const value = args[++index] as RunTier;
    if (!RUN_TIERS.includes(value)) fail(`--tier takes ${RUN_TIERS.join(", ")}`, 2);
    flags.tier = value;
  } else if (arg === "--days" || arg === "--limit") {
    const value = Number(args[++index]);
    if (!Number.isInteger(value) || value < 1) fail(`${arg} needs a positive whole number`, 2);
    flags[arg === "--days" ? "days" : "limit"] = value;
  } else if (arg === "--help" || arg === "-h" || arg === "help") {
    console.log(help);
    process.exit(0);
  } else if (arg.startsWith("--")) fail(`Unknown option ${arg}; see verify --help`, 2);
  else positional.push(arg);
}

function fail(message: string, code = 1): never {
  console.error(flags.json ? JSON.stringify({ error: message }) : `verify: ${message}`);
  process.exit(code);
}

// ── formatting ─────────────────────────────────────────────────────────────────────────────────────────────────────

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;

  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;

  return `${Math.round(minutes / 1440)}d ago`;
}

const percent = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const title = (text: string) => pc.bold(pc.cyan(text));
const dim = pc.dim;
const statusMark = (ok: boolean) => (ok ? pc.green("✔ passed") : pc.red("✘ failed"));
const projectName = (project: string) => project.replace(/-project$/, "").toUpperCase();
const pad = (text: string, width: number) => text.padEnd(width);
const padStart = (text: string, width: number) => text.padStart(width);
/** Pads colored text by what it shows, not its escape codes. */
const padShown = (text: string, width: number) =>
  text + " ".repeat(Math.max(0, width - Bun.stripANSI(text).length));
/** A run's time with its absolute band, then how it compares with usual. */
const vsUsual = (
  rating: Rating,
  actual: number,
  change: number | null,
  usual: number | null,
  samples: number,
  what: string,
) =>
  usual === null
    ? `${rating} ${duration(actual)} ${dim(`(no usual yet: ${samples} ${what} in ${USUAL_DAYS}d, needs 3)`)}`
    : `${rating} ${duration(actual)}  ${dotted(changeText(change, usual) || dim(`usual ${duration(usual)}`), dim(`median of ${samples} ${what}, ${USUAL_DAYS}d`))}`;

function describeRun(run: RunRecord): string {
  const parts = [
    run.branch ?? (run.report.mergedMain ? run.report.mergedMain.branch : "detached"),
    run.report.head?.slice(0, 8) ?? (run.source === "heavy-run" ? "seeded" : "no commit"),
    run.host,
    ago(run.recordedAt),
  ];

  return dim(parts.join(" · "));
}

// ── data ───────────────────────────────────────────────────────────────────────────────────────────────────────────

async function load() {
  let unreachable: string[] = [];

  if (flags.pull) {
    let hosts: string[] = [];
    try {
      hosts = readSetupMirrors(homedir());
    } catch {
      /* No device profile: nothing to pull. */
    }
    if (hosts.length) unreachable = (await pullSpareHosts(hosts)).unreachable;
  }

  const history = readHistory();
  const notes: string[] = [];
  if (unreachable.length)
    notes.push(`Could not reach ${unreachable.join(", ")}; their recent sign-offs may be missing.`);
  for (const [version, count] of Object.entries(history.refused))
    notes.push(
      `Refused ${count} runs with report version ${version}; this verify knows ${KNOWN_REPORT_VERSIONS.join(", ")}. Update my-setup.`,
    );

  return { runs: history.runs, notes };
}

function projectsIn(runs: RunRecord[]): string[] {
  const here = projectOf(process.cwd());
  const all = [...new Set(runs.map((run) => run.project))].sort();

  if (flags.project) {
    const match = all.filter(
      (project) => project === flags.project || project.startsWith(flags.project!),
    );
    if (!match.length)
      fail(`No runs for project ${flags.project}; known: ${all.join(", ") || "none"}`, 2);

    return match;
  }

  return here && all.includes(here) ? [here] : all;
}

const visible = (run: RunRecord) => run.report.command !== "pre-push";

function printNotes(notes: string[]) {
  for (const note of notes) console.log(pc.yellow(`! ${note}`));
}

// ── project boxes ──────────────────────────────────────────────────────────────────────────────────────────────────

/** On a terminal each project's section is a rounded box; --json and piped output stay plain text. */
const framing = Boolean(process.stdout.isTTY) && !flags.json;
const BOX_MAX = 120;
const BOX_PAD = 2;
const boxes: { heading: string; lines: string[] }[] = [];
let boxLines: string[] | null = null;

function out(text = "") {
  if (boxLines) boxLines.push(...text.split("\n"));
  else console.log(text);
}

/** Starts a project's section: on a terminal, a box titled with the project and `extra`; otherwise a heading line. */
function section(name: string, extra = "") {
  const heading = `${title(name)}${extra ? `${dim(" · ")}${extra}` : ""}`;
  if (!framing) {
    out("");
    out(heading);
    return;
  }

  boxLines = [];
  boxes.push({ heading, lines: boxLines });
}

/** Draws the sections started since the last call, all one width: the widest line's, up to 120 columns or the terminal. */
function printBoxes() {
  boxLines = null;
  if (!boxes.length) return;

  const widest = Math.max(
    ...boxes.flatMap(({ heading, lines }) => [
      Bun.stringWidth(heading) + 4,
      ...lines.map((line) => Bun.stringWidth(line)),
    ]),
  );
  const width = Math.min(BOX_MAX, process.stdout.columns || BOX_MAX, widest + 2 * BOX_PAD + 2);
  const inner = width - 2 * BOX_PAD - 2;
  const side = dim("│") + " ".repeat(BOX_PAD);
  for (const { heading, lines } of boxes.splice(0)) {
    while (lines.at(-1) === "") lines.pop();
    while (lines[0] === "") lines.shift();
    // The title carries the heading, so the indent under it goes; escape codes hold no spaces.
    if (lines.every((line) => !line || Bun.stripANSI(line).startsWith("  ")))
      lines.forEach((line, index) => (lines[index] = line.replace("  ", "")));
    console.log("");
    console.log(
      `${dim("╭─ ")}${heading}${dim(` ${"─".repeat(Math.max(0, width - 5 - Bun.stringWidth(heading)))}╮`)}`,
    );
    for (const line of lines.flatMap((text) =>
      Bun.stringWidth(text) > inner
        ? Bun.wrapAnsi(text, inner, { hard: true, trim: false }).split("\n")
        : [text],
    ))
      console.log(
        `${side}${line}${" ".repeat(Math.max(0, inner - Bun.stringWidth(line)))}${" ".repeat(BOX_PAD)}${dim("│")}`,
      );
    console.log(dim(`╰${"─".repeat(width - 2)}╯`));
  }
}

// ── views ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function dashboard(runs: RunRecord[], projects: string[]) {
  const now = Date.now();
  const data = projects.map((project) => {
    const signoffs = runs.filter(
      (run) => run.project === project && run.report.command === "signoff",
    );
    const last = signoffs.at(-1) ?? null;

    return {
      project,
      last: last ? profile(runs, last) : null,
      slowest: slowSteps(runs, project, now, flags.days).slice(0, 3),
      failures: repeatingFailures(
        runs.filter((run) => run.project === project),
        now,
        flags.days,
      ),
      trend: trend(runs, project, "signoff", now, flags.days),
      runs7d: runs.filter(
        (run) => run.project === project && visible(run) && now - at(run) < flags.days * DAY,
      ).length,
    };
  });

  if (flags.json)
    return data.map((item) => ({ ...item, last: item.last && jsonProfile(item.last) }));

  for (const item of data) {
    section(
      projectName(item.project),
      dim(`${item.runs7d} runs in ${flags.days}d`),
    );

    if (!item.last) {
      out(dim("  No sign-off recorded yet."));
    } else {
      const { run, usual, rating } = item.last;
      out(`  Last sign-off   ${statusMark(passed(run))}  ${describeRun(run)}`);
      out(
        `  Time            ${vsUsual(rating, run.report.seconds, item.last.change, usual.seconds, usual.samples, "passing sign-offs")}`,
      );
      const failed = item.last.steps.filter((step) => step.status === "failed");
      if (failed.length)
        out(`  Failed          ${pc.red(failed.map((step) => step.task).join(", "))}`);
      for (const error of run.report.errors)
        out(`  Error           ${pc.red(error.item)} ${dim(error.log)}`);
      const ran = item.last.steps.filter((step) => !step.reused && step.status !== "skipped");
      out(
        `  Steps           ${ran.length} ran, ${item.last.steps.length - ran.length} reused or skipped${item.last.waitSeconds ? `, ${duration(item.last.waitSeconds)} queue wait` : ""}`,
      );
      const top = [...ran].sort((a, b) => b.ranSeconds - a.ranSeconds).slice(0, 3);
      if (top.length) {
        out(`  Its slowest`);
        for (const step of top) out(`    ${stepLine(step)}`);
      }
    }

    out(`  Slowest steps   ${dim(`median run time per sign-off, last ${flags.days}d`)}`);
    if (!item.slowest.length) out(dim("    none recorded"));
    for (const step of item.slowest)
      out(
        `    ${rateStepTime(step.medianSeconds)} ${pad(step.task, 26)} ${padStart(duration(step.medianSeconds), 6)}  ${dim(`in ${step.runs} sign-offs${step.medianWait ? `, waits ${duration(step.medianWait)}` : ""}`)}`,
      );

    out(
      `  Repeating failures  ${dim(`last ${flags.days}d · 🔴 3+ branches · 🟠 2 branches · ⚪ one branch`)}`,
    );
    if (!item.failures.length) out(`    🟢 none ${dim("(no step failed twice)")}`);
    for (const failure of item.failures.slice(0, 5)) out(`    ${failureLine(failure)}`);

    trendTable(item.trend, "  ");
  }
  printBoxes();
  out("");
  out(
    dim(
      "verify profile --run signoff · verify profile · verify steps · verify trend · verify failures · verify --help",
    ),
  );
}

function stepLine(step: Profile["steps"][number]): string {
  const notes = dotted(
    changeText(step.change, step.usual.seconds),
    step.waitSeconds >= 1 && dim(`+${duration(step.waitSeconds)} queue`),
  );

  return `${step.rating} ${pad(step.task, 26)} ${padStart(duration(step.ranSeconds), 6)}${notes ? `  ${notes}` : ""}`;
}

function failureLine(failure: ReturnType<typeof repeatingFailures>[number]): string {
  return `${failure.rating} ${pad(failure.task, 26)} ${pc.red(`failed ${failure.failures} of ${failure.runs} runs`)} ${dim(`on ${failure.branches} branch${failure.branches === 1 ? "" : "es"} · last ${ago(failure.lastAt)}${failure.lastBranch ? ` on ${failure.lastBranch}` : ""}`)}`;
}

function trendTable(data: ReturnType<typeof trend>, indent = "") {
  out(
    `${indent}Sign-off trend  ${dim(`vs ${USUAL_DAYS}d: ${percent(data.usualPass)} pass, ${duration(data.usualTime)} median, ${data.baselineRuns} runs`)}`,
  );
  out(dim(`${indent}  ${pad("day", 12)} ${padStart("runs", 4)}   ${pad("pass", 7)}   median`));
  for (const row of data.rows) {
    const bar = pc.green("▇".repeat(Math.min(row.runs, 30)));
    out(
      `${indent}  ${pad(row.day, 12)} ${padStart(String(row.runs), 4)}   ${row.passRate === null ? "  —    " : `${row.passRating} ${pad(percent(row.passRate), 5)}`}   ${row.medianSeconds === null ? "  —   " : `${row.timeRating} ${pad(duration(row.medianSeconds), 6)}`}  ${bar}`,
    );
  }
}

function jsonProfile(item: Profile) {
  return { ...item, run: { ...item.run, report: { ...item.run.report, checks: undefined } } };
}

const PHASE_LABELS = {
  first: "① first, in order",
  parallel: "② parallel",
  isolated: "③ alone, one by one",
  last: "④ last",
} as const;
/** Profiles stay this narrow, so they fit a split terminal and a phone screenshot. */
const LINE = 80;

/** The run's schedule from its report, or from the project's current config for reports that predate it. */
async function planOf(run: RunRecord): Promise<CheckPlan | null> {
  return run.report.plan ?? (await canonicalPlan(run.project));
}

/** Words joined with a dim dot, empty ones dropped. */
const dotted = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(dim(" · "));

const LABEL = 8;

/** One fact of a run's header: a dim label, then its value, wrapping under itself past the line width. */
function field(label: string, value: string) {
  const lines = Bun.wrapAnsi(value, LINE - LABEL - 2, { hard: true }).split("\n");
  lines.forEach((line, index) => out(`  ${dim(pad(index ? "" : label, LABEL))}${line}`));
}

/** Where a run came from: branch @ commit · host · when. */
function commitText(run: RunRecord): string {
  const branch = run.branch ?? (run.report.mergedMain ? run.report.mergedMain.branch : "detached");
  const head = run.report.head?.slice(0, 8);

  return dotted(head ? `${branch} @ ${head}` : branch, run.host, ago(run.recordedAt));
}

/** The run's header facts shared by the profile and the Pest view. */
function runFields(run: RunRecord) {
  field("commit", commitText(run));
  for (const error of run.report.errors)
    field("error", `${pc.red(`✘ ${error.item}`)} ${error.log}`);
  for (const warning of run.report.warnings ?? []) field("warning", warning);
}

/** The phase table's columns after the name: took, share of the run, step count, then the slot wait. */
const tableRow = (took: string, share: string, count: string, waited: string, notes: string) =>
  `${padStart(took, 6)}  ${padStart(share, 6)}  ${padStart(count, 5)}  ${notes ? pad(padStart(waited, 6), 17) : padStart(waited, 6)}${notes ? `  ${notes}` : ""}`.trimEnd();

async function showProfile(item: Profile) {
  const view = phaseProfile(item, await planOf(item.run));
  if (flags.json) return { ...jsonProfile(item), phases: view };

  const { run, usual, rating, steps } = item;
  const tier = runTier(run);
  const ran = steps.filter((step) => !step.reused && step.status !== "skipped");
  const reused = steps.filter((step) => step.reused).map((step) => step.task);
  const skipped = steps.filter((step) => step.status === "skipped").map((step) => step.task);

  section(
    projectName(run.project),
    `${run.report.command}${tier === "gate" ? "" : ` ${tier}`} ${statusMark(passed(run))}`,
  );
  runFields(run);
  const plain = (text: string) => Bun.stripANSI(text);
  field(
    "time",
    ran.length || !steps.length
      ? `${rating} ${duration(run.report.seconds)}   ${dotted(plain(changeText(item.change, usual.seconds)), `critical path ${duration(view.criticalPath)}`)}`
      : `⚪ ${duration(run.report.seconds)}   nothing ran: every step reused an earlier pass (-- --fresh reruns them)`,
  );
  field(
    "waited",
    dotted(
      `queue ${duration(item.waitSeconds)}`,
      view.otherSeconds >= 1 && `setup ${duration(view.otherSeconds)}`,
    ),
  );
  field(
    "steps",
    dotted(
      `${ran.length} ran`,
      `${reused.length} reused`,
      skipped.length > 0 && `${skipped.length} skipped after a failure`,
    ),
  );
  if (flags.verbose && reused.length) field("reused", reused.join(", "));
  if (skipped.length) field("skipped", skipped.join(", "));
  if (run.report.areas.length) field("areas", run.report.areas.join(", "));
  if (!view.plan) field("note", "no check config found, so every step shows as parallel");

  // Parallel steps slowest first; the others in the order they ran.
  const phases = view.phases
    .filter((phase) => phase.steps.length)
    .map((phase) =>
      phase.phase === "parallel"
        ? { ...phase, steps: [...phase.steps].sort((a, b) => b.ranSeconds - a.ranSeconds) }
        : phase,
    );
  const nameWidth = Math.max(
    22,
    ...phases.flatMap((phase) => phase.steps.map((step) => step.task.length)),
  );
  // Step rows start 6 columns further in ("     🟠 " against "  "), so phase times line up with step times.
  const labelWidth = nameWidth + 6;
  out("");
  out(
    dim(`  ${pad("", labelWidth)} ${tableRow("took", "of run", "steps", "waited for a slot", "")}`),
  );
  for (const phase of phases) {
    const label =
      phase.phase === "parallel"
        ? `${PHASE_LABELS.parallel}, ${view.slots}${view.jobs === null ? "*" : ""} at once`
        : PHASE_LABELS[phase.phase];
    const used =
      phase.phase === "parallel" && view.efficiency !== null
        ? `slots ${Math.round(view.efficiency * 100)}% used`
        : "";
    out(
      `  ${pc.bold(pad(label, labelWidth))} ${tableRow(duration(phase.seconds), `${Math.round(phase.share * 100)}%`, String(phase.steps.length), "", used)}`,
    );

    for (const step of phase.steps) {
      const notes = dotted(
        step.status === "failed" && pc.red("FAILED"),
        step.tier === "full" && "full sign-off only",
        plain(changeText(step.change, step.usual.seconds)),
      );
      out(
        `     ${step.rating} ${pad(step.task, nameWidth)} ${tableRow(duration(step.ranSeconds), "", "", step.waitSeconds >= 1 ? duration(step.waitSeconds) : "", notes)}`,
      );
      if (step.status === "failed" && step.log) out(dim(`        log ${step.log}`));
    }
    out("");
  }

  return undefined;
}

/** "+40% vs usual 28s" when clearly slower than usual, red over 50%; empty otherwise, since faster needs no action. */
function changeText(change: number | null, usual: number | null, against = "usual"): string {
  if (change === null || usual === null || change <= 0) return "";

  const text = `+${Math.round(change * 100)}% vs ${against} ${duration(usual)}`;

  return change > 0.5 ? pc.red(text) : pc.yellow(text);
}

/** Prints each run's profile in turn; with --json, returns them. */
async function profiles(runs: RunRecord[], chosen: RunRecord[]) {
  const results = [];
  for (const run of chosen) results.push(await showProfile(profile(runs, run)));
  printBoxes();

  return flags.json ? (results.length === 1 ? results[0] : results) : undefined;
}

function recentRuns(runs: RunRecord[], projects: string[]) {
  return runs.filter((run) => projects.includes(run.project) && visible(run)).reverse();
}

function selectRun(runs: RunRecord[], projects: string[], selector?: string): RunRecord {
  const recent = recentRuns(runs, projects);

  if (!selector) return recent[0] ?? fail("No runs recorded yet; try verify profile --run");
  if (/^\d{1,3}$/.test(selector))
    return (
      recent[Number(selector) - 1] ??
      fail(`No run #${selector}; verify runs lists ${recent.length}`, 2)
    );

  return (
    recent.find((run) => run.report.head?.startsWith(selector) || run.id.startsWith(selector)) ??
    fail(`No run matches ${selector}`, 2)
  );
}

function listRuns(runs: RunRecord[], projects: string[]) {
  const recent = recentRuns(runs, projects).slice(0, flags.limit);
  if (flags.json) return recent;

  out("");
  out(
    dim(
      `  #   ${pad("when", 9)} ${pad("project", 8)} ${pad("command", 9)} ${pad("tier", 7)} ${pad("result", 9)} ${padStart("time", 9)}  ${pad("vs usual", 24)}  branch · commit · host`,
    ),
  );
  recent.forEach((run, index) => {
    const usualRating = profile(runs, run);
    out(
      `  ${padStart(String(index + 1), 2)}  ${pad(ago(run.recordedAt), 9)} ${pad(projectName(run.project).slice(0, 8), 8)} ${pad(run.report.command, 9)} ${runTier(run) === "gate" ? dim(pad("gate", 7)) : pc.magenta(pad(runTier(run), 7))} ${passed(run) ? pc.green(pad("passed", 9)) : pc.red(pad("failed", 9))} ${usualRating.rating} ${padStart(duration(run.report.seconds), 6)}  ${padShown(changeText(usualRating.change, usualRating.usual.seconds) || dim("·"), 24)}  ${dim(`${run.branch ?? "detached"} · ${run.report.head?.slice(0, 8) ?? "—"} · ${run.host}`)}`,
    );
  });
  out(dim("\n  verify profile <#> shows one run's timeline"));

  return undefined;
}

async function stepsView(runs: RunRecord[], projects: string[]) {
  const now = Date.now();
  // A step's tier comes from the latest run's schedule, or the project's config when no run recorded one.
  const plans = new Map<string, CheckPlan | null>();
  for (const project of projects) {
    const latest = recentRuns(runs, [project]).find((run) => run.report.plan);
    plans.set(project, latest?.report.plan ?? (await canonicalPlan(project)));
  }
  const data = projects.map((project) => ({
    project,
    steps: slowSteps(runs, project, now, flags.days).map((step) => ({
      ...step,
      tier: stepTier(plans.get(project) ?? null, step.task),
    })),
  }));
  if (flags.json) return data;

  for (const { project, steps } of data) {
    // The same steps over the window before, so a step that got slower stands out.
    const before = slowSteps(
      runs.filter((run) => at(run) < now - flags.days * DAY),
      project,
      now - flags.days * DAY,
      USUAL_DAYS,
    );
    section(
      projectName(project),
      dim(`${flags.tier ? `${flags.tier} ` : ""}sign-off steps, median over ${flags.days}d`),
    );
    out(
      dim(
        `     ${pad("step", 26)} ${padStart("median", 6)} ${padStart("runs", 5)} ${padStart("in", 5)} ${padStart("wait", 6)}`,
      ),
    );
    for (const step of steps.slice(0, flags.limit)) {
      const previous = before.find((item) => item.task === step.task)?.medianSeconds ?? null;
      const notes = dotted(
        step.tier === "full" && pc.magenta("full"),
        changeText(
          changeVsUsual(step.medianSeconds, previous),
          previous,
          `the ${USUAL_DAYS}d before`,
        ),
      );
      out(
        `  ${rateStepTime(step.medianSeconds)} ${pad(step.task, 26)} ${padStart(duration(step.medianSeconds), 6)} ${padStart(String(step.runs), 5)} ${padStart(percent(step.share), 5)} ${padStart(step.medianWait ? duration(step.medianWait) : "·", 6)}${notes ? `  ${notes}` : ""}`,
      );
    }
    if (!steps.length) out(dim("  No sign-off steps recorded in this window."));
  }
  printBoxes();
  out(dim(`\n  in: share of sign-offs that ran the step · full: runs only in full sign-offs`));

  return undefined;
}

function trendView(runs: RunRecord[], projects: string[]) {
  const now = Date.now();
  const data = projects.map((project) => ({
    project,
    ...trend(runs, project, "signoff", now, flags.days),
  }));
  if (flags.json) return data;

  for (const item of data) {
    section(projectName(item.project), flags.tier ? dim(`${flags.tier} sign-offs only`) : "");
    trendTable(item, "  ");
  }
  printBoxes();

  return undefined;
}

function failuresView(runs: RunRecord[], projects: string[]) {
  const now = Date.now();
  const data = projects.map((project) => ({
    project,
    failures: repeatingFailures(
      runs.filter((run) => run.project === project),
      now,
      flags.days,
    ),
  }));
  if (flags.json) return data;

  for (const { project, failures } of data) {
    section(
      projectName(project),
      dim(
        `failed twice or more, last ${flags.days}d · 🔴 3+ branches · 🟠 2 branches · ⚪ one branch`,
      ),
    );
    if (!failures.length) out(`  🟢 none ${dim("(no step failed twice)")}`);
    for (const failure of failures.slice(0, flags.limit)) out(`  ${failureLine(failure)}`);
  }
  printBoxes();

  return undefined;
}

// ── commands ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function record() {
  const input = await new Response(Bun.stdin.stream()).text();
  let report: CheckReport;
  try {
    report = JSON.parse(input) as CheckReport;
  } catch {
    fail("record expects check.ts's --json report on stdin", 2);
  }
  const stored = recordRun(report, process.cwd());
  if (flags.json) out(JSON.stringify({ recorded: stored?.id ?? null }));
}

/** The slowest tests of one run per project (or the chosen run), then the project's tests getting slower. */
function pestView(runs: RunRecord[], projects: string[], selector?: string) {
  const chosen = selector
    ? [selectRun(runs, projects, selector)]
    : projects
        .map((project) => recentRuns(runs, [project]).find((run) => run.pest))
        .filter((run): run is RunRecord => Boolean(run));
  if (!chosen.length)
    fail(
      "No run has Pest times yet; check runs record them when their Pest check runs rather than being reused",
    );
  if (selector && !chosen[0]!.pest)
    fail(
      "That run kept no Pest times: its Pest check was reused or skipped, or it predates per-test recording",
      2,
    );

  const views = chosen.map((run) => ({
    ...pestProfile(runs, run),
    slower: slowerTests(runs, run.project, Date.now(), flags.days),
  }));
  if (flags.json) return views;

  for (const { run, pest, tests, slower } of views) {
    section(projectName(run.project), `pest in ${run.report.command} ${statusMark(passed(run))}`);
    runFields(run);
    field(
      "tests",
      `${pest.tests} ${dim("·")} ${duration(pest.seconds)} summed across workers ${dim("·")} the ${pest.slowest.length} slowest kept`,
    );
    out("");
    out(dim(`     ${padStart("time", 7)}  ${pad("usual", 7)}  test`));
    for (const test of tests.slice(0, flags.limit))
      out(
        `  ${test.rating} ${padStart(secs(test.seconds), 7)}  ${pad(test.usual.seconds === null ? (test.usual.samples ? "few" : "new") : secs(test.usual.seconds), 7)}  ${test.name}${dim(`  ${test.file}`)}`,
      );
    out("");
    if (!slower.length)
      out(
        dim(
          `  Getting slower: none over the last ${flags.days}d against the ${USUAL_DAYS}d before`,
        ),
      );
    else {
      out(
        dim(`  Getting slower: median over the last ${flags.days}d vs the ${USUAL_DAYS}d before`),
      );
      for (const test of slower.slice(0, 10))
        out(
          `  ${test.rating} ${padStart(secs(test.usual), 7)} → ${pad(secs(test.seconds), 7)} ${dim(`${test.runs} runs`)}  ${test.name}${dim(`  ${test.file}`)}`,
        );
    }
  }
  printBoxes();
  out("");
  out(
    dim(
      `  ratings: test time vs its ${USUAL_DAYS}d median (🟠 >15%, 🔴 >50% slower; under 0.25s apart is ⚪) · "new": not among the kept slowest before · "few": under 3 samples`,
    ),
  );

  return views;
}

const secs = (value: number) => `${value.toFixed(2)}s`;

async function runAndProfile(task: string) {
  if (positional[1]) fail("profile --run runs a new task; drop the run number or commit", 2);
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).stdout.trim();
  const project = root && projectOf(root);
  if (!project) fail("profile --run needs a project checkout; cd into one first", 2);

  const started = Date.now();
  console.log(
    dim(
      `→ mise run ${task}${passthrough.length ? ` -- ${passthrough.join(" ")}` : ""}  (in ${root})`,
    ),
  );
  const child = spawnSync(
    "mise",
    ["run", task, ...(passthrough.length ? ["--", ...passthrough] : [])],
    {
      cwd: root,
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  const runs = readHistory().runs;
  const latest = runs
    .filter(
      (item) => item.project === project && item.host === shortHost() && at(item) >= started - 1000,
    )
    .at(-1);

  if (!latest)
    fail(
      `mise run ${task} exited ${child.status} but recorded no report; this checkout's scripts/check.ts predates history recording`,
    );

  const result = await showProfile(profile(runs, latest));
  printBoxes();
  if (result) console.log(JSON.stringify(result));
  process.exit(child.status ?? 1);
}

const command = positional[0] ?? "dashboard";
if (flags.run && command !== "profile") fail("--run works only with verify profile", 2);

if (command === "record") await record();
else if (command === "run")
  fail("verify run is now verify profile --run [check|signoff|premerge]", 2);
else if (command === "profile" && positional[1] === "pest" && flags.run)
  fail(
    "Pest times come from check runs: run verify profile --run check, then verify profile pest",
    2,
  );
else if (command === "profile" && flags.run) await runAndProfile(flags.run);
else {
  const { runs, notes } = await load();
  const projects = projectsIn(runs);
  let result: unknown;

  if (flags.tier && !["runs", "steps", "trend"].includes(command))
    fail("--tier works with verify runs, steps, and trend", 2);
  const tiered = flags.tier ? runs.filter((run) => runTier(run) === flags.tier) : runs;

  if (!flags.json) printNotes(notes);
  if (command === "dashboard") result = dashboard(runs, projects);
  else if (command === "profile" && positional[1] === "pest")
    result = pestView(runs, projects, positional[2]);
  else if (command === "profile")
    // A chosen run is one profile; otherwise each shown project's last run, so outside a repo both projects appear.
    result = await profiles(
      runs,
      positional[1]
        ? [selectRun(runs, projects, positional[1])]
        : projects
            .map((project) => recentRuns(runs, [project])[0])
            .filter((run): run is RunRecord => Boolean(run)),
    );
  else if (command === "runs") result = listRuns(tiered, projects);
  else if (command === "steps") result = await stepsView(tiered, projects);
  else if (command === "trend") result = trendView(tiered, projects);
  else if (command === "failures") result = failuresView(runs, projects);
  else fail(`Unknown command ${command}; see verify --help`, 2);

  if (flags.json) console.log(JSON.stringify({ notes, projects, result }));
}
