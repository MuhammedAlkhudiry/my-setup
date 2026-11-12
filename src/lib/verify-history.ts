import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { type PestRecord, readPestTimings } from "./verify-pest";

/** The check reports (`scripts/check.ts --json`) this reader understands; any other version is refused. */
export const KNOWN_REPORT_VERSIONS = [1] as const;

/** Mirrors `scripts/check.ts`'s receipt; `startedSeconds` is absent in reports written before it existed. */
export interface CheckReport {
  version: number;
  command: "check" | "signoff" | "premerge" | "pre-push" | string;
  head: string | null;
  base: string | null;
  mode: string;
  areas: string[];
  checks: {
    task: string;
    status: "passed" | "failed" | "skipped";
    seconds: number;
    reused: boolean;
    log: string | null;
    startedSeconds?: number;
  }[];
  /** How check.ts scheduled the checks; absent in reports written before it recorded it. */
  plan?: CheckPlan | null;
  seconds: number;
  exitCode: number;
  mergedMain?: { from: string; to: string; branch: string } | null;
  errors: { item: string; log: string }[];
  warnings?: string[];
}

/**
 * A project's check schedule, from its scripts/check-config.ts: the first checks run in order, the rest `jobs` at a time,
 * then the isolated and last checks one by one. `full` names the checks only full runs add (fullChecks).
 */
export interface CheckPlan {
  /** How many checks ran at once; unknown when read from the config rather than a run's report. */
  jobs?: number;
  first: string[];
  isolated: string[];
  last: string[];
  full: string[];
}

/** One stored run. */
export interface RunRecord {
  schema: 1;
  id: string;
  recordedAt: string;
  host: string;
  project: string;
  branch: string | null;
  report: CheckReport;
  /** The Pest check's slowest tests, when it ran in this run rather than being reused. */
  pest?: PestRecord;
  /** Set from VERIFY_RUN_TAG: the merge queue tags its nightly full sign-off of main. */
  tag?: "nightly";
}

const DAY = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 180;
const MAX_BYTES = 40_000_000;

const stateDirectory = () => process.env.VERIFY_STATE_DIR ?? join(homedir(), ".local/state/verify");
export const historyPath = (directory = stateDirectory()) => join(directory, "runs.jsonl");

function git(cwd: string, ...args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });

  return result.status === 0 ? result.stdout.trim() || null : null;
}

/** The GitHub repository name, such as "harium-project"; null for clones without a GitHub origin, such as test fixtures. */
export function projectOf(cwd: string): string | null {
  const url = git(cwd, "remote", "get-url", "origin");

  return url?.match(/github\.com[:/][^/]+\/([^/]+?)(?:\.git)?$/)?.[1] ?? null;
}

export const shortHost = () => hostname().replace(/\.local$/, "");

/** Keeps the report small enough for months of runs: only failed steps keep their log, and no artifact folder. */
function compact(report: CheckReport): CheckReport {
  const { artifacts: _artifacts, ...rest } = report as CheckReport & { artifacts?: unknown };

  return {
    ...rest,
    checks: report.checks.map((check) => ({
      ...check,
      seconds: Math.round(check.seconds * 10) / 10,
      ...(check.startedSeconds === undefined
        ? {}
        : { startedSeconds: Math.round(check.startedSeconds * 10) / 10 }),
      log: check.status === "failed" ? check.log : null,
    })),
    seconds: Math.round(report.seconds * 10) / 10,
  };
}

/** Stores one finished check run; returns null when the checkout has no GitHub origin, as in check.ts's own tests. */
export function recordRun(
  report: CheckReport,
  cwd: string,
  options: {
    directory?: string;
    now?: number;
    tag?: string;
  } = {},
): RunRecord | null {
  const project = projectOf(cwd);
  if (!project) return null;

  const now = options.now ?? Date.now();
  const record: RunRecord = {
    schema: 1,
    id: randomUUID(),
    recordedAt: new Date(now).toISOString(),
    host: shortHost(),
    project,
    branch: report.mergedMain?.branch ?? git(cwd, "branch", "--show-current"),
    report: compact(report),
  };
  const pest = readPestTimings((report as { artifacts?: { logs?: string } }).artifacts?.logs);
  if (pest) record.pest = pest;
  if ((options.tag ?? process.env.VERIFY_RUN_TAG) === "nightly") record.tag = "nightly";
  appendRecords([record], options.directory);

  return record;
}

function appendRecords(records: RunRecord[], directory = stateDirectory()): void {
  if (!records.length) return;

  const path = historyPath(directory);
  mkdirSync(directory, { recursive: true });
  appendFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), {
    mode: 0o600,
  });

  if (statSync(path).size > MAX_BYTES) trimHistory(directory);
}

/** Drops runs older than KEEP_DAYS, then the oldest until the file is under half its size cap. */
export function trimHistory(directory = stateDirectory(), now = Date.now()): void {
  const path = historyPath(directory);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const kept = lines.filter((line) => {
    const at = Date.parse(line.match(/"recordedAt":"([^"]+)"/)?.[1] ?? "");

    return !Number.isFinite(at) || now - at < KEEP_DAYS * DAY;
  });
  let size = kept.reduce((total, line) => total + line.length + 1, 0);

  while (kept.length && size > MAX_BYTES / 2) size -= kept.shift()!.length + 1;

  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  renameSync(temporary, path);
}

export interface History {
  runs: RunRecord[];
  /** Report versions this reader refused, with how many runs carried each. */
  refused: Record<string, number>;
}

export function parseHistory(text: string): History {
  const runs: RunRecord[] = [];
  const refused: Record<string, number> = {};
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line) continue;

    let record: RunRecord;
    try {
      record = JSON.parse(line) as RunRecord;
    } catch {
      continue;
    }

    const version = record.schema === 1 ? record.report?.version : `schema ${record.schema}`;
    if (!KNOWN_REPORT_VERSIONS.includes(version as 1)) {
      refused[String(version)] = (refused[String(version)] ?? 0) + 1;
      continue;
    }
    if (seen.has(record.id)) continue;

    seen.add(record.id);
    runs.push(record);
  }
  runs.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  return { runs, refused };
}

export function readHistory(directory = stateDirectory()): History {
  const path = historyPath(directory);

  return parseHistory(existsSync(path) ? readFileSync(path, "utf8") : "");
}

/**
 * Copies runs recorded on spare Macs, such as merge-queue sign-offs on small-mac, into this Mac's history. Reads only the
 * bytes added since the last pull; unreachable hosts are skipped and reported.
 */
export async function pullSpareHosts(
  hosts: string[],
  directory = stateDirectory(),
  timeoutSeconds = 4,
): Promise<{ pulled: number; unreachable: string[] }> {
  const offsetsPath = join(directory, "pull-offsets.json");
  const offsets: Record<string, number> = existsSync(offsetsPath)
    ? JSON.parse(readFileSync(offsetsPath, "utf8"))
    : {};
  const known = new Set(readHistory(directory).runs.map((run) => run.id));
  const unreachable: string[] = [];
  let pulled = 0;
  const results = await Promise.all(
    hosts.map(async (host) => {
      const offset = offsets[host] ?? 0;
      const script = `f=~/.local/state/verify/runs.jsonl; [ -f "$f" ] || { echo 0; exit; }; s=$(wc -c <"$f"); echo $s; if [ $s -ge ${offset} ]; then tail -c +${offset + 1} "$f"; else cat "$f"; fi`;
      const child = Bun.spawn(
        ["ssh", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeoutSeconds}`, host, script],
        { stdout: "pipe", stderr: "ignore" },
      );
      const timer = setTimeout(() => child.kill(), (timeoutSeconds + 4) * 1000);
      const text = await new Response(child.stdout).text();
      clearTimeout(timer);

      return { host, ok: (await child.exited) === 0, text };
    }),
  );

  for (const { host, ok, text } of results) {
    if (!ok) {
      unreachable.push(host);
      continue;
    }

    const newline = text.indexOf("\n");
    const size = Number(text.slice(0, newline === -1 ? undefined : newline));
    const fresh = parseHistory(newline === -1 ? "" : text.slice(newline + 1)).runs.filter(
      (run) => !known.has(run.id),
    );
    appendRecords(fresh, directory);
    pulled += fresh.length;
    offsets[host] = size;
  }

  mkdirSync(dirname(offsetsPath), { recursive: true });
  writeFileSync(offsetsPath, JSON.stringify(offsets));

  return { pulled, unreachable };
}

const plans = new Map<string, Promise<CheckPlan | null>>();

/**
 * The schedule in a project's canonical clone, for runs whose report predates `plan`; null for projects outside
 * ACTIVE_PROJECTS or a config that fails to load.
 */
export function canonicalPlan(project: string): Promise<CheckPlan | null> {
  if (!plans.has(project)) {
    const root = ACTIVE_PROJECTS.find(
      (item) => basename(item.canonicalRoot) === project,
    )?.canonicalRoot;
    plans.set(
      project,
      root
        ? import(join(root, "scripts/check-config.ts"))
            .then(({ default: config }) => ({
              first: config.runFirst ?? [],
              isolated: config.runIsolated ?? [],
              last: config.runLast ?? [],
              full: Object.keys(config.fullChecks ?? {}),
            }))
            .catch(() => null)
        : Promise.resolve(null),
    );
  }

  return plans.get(project)!;
}
