import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execa } from "execa";
import { z } from "zod";

import { ACTIVE_PROJECTS, type ActiveProject } from "../../config/active-projects";
import { timedCommand } from "./timed-command";

export const WORKTREE_SIZE_WARNING_BYTES = 20 * 1024 ** 3;
export const WORKTREE_CLEANUP_GRACE_MS = 4 * 60 * 60 * 1000;
const CLEANUP_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const cleanupCacheSchema = z.object({
  completedAt: z.iso.datetime(),
  t3Worktrees: z.number().int().nonnegative(),
  t3Bytes: z.number().int().nonnegative(),
  unmeasuredWorktrees: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

const threadBindingSchema = z.object({
  title: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  archivedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  settledOverride: z.enum(["settled", "unsettled"]).nullable(),
  settledAt: z.string().nullable(),
  unsettledAt: z.string().nullish(),
  updatedAt: z.string().optional(),
});

export interface CleanupPr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  branch: string;
  head: string;
  updatedAt: string;
  finishedAt?: string | null;
}

export interface CleanupThread {
  title: string;
  projectRoot: string;
  worktreePath: string | null;
  branch: string | null;
  lastActivityAt?: string;
  running?: boolean;
}

interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

export interface CleanupEntry {
  kind: "worktree" | "branch";
  project: string;
  path: string | null;
  branch: string | null;
  head: string;
  pr: CleanupPr | null;
  clean: boolean | null;
  unpushedCommits: number | null;
  sizeBytes: number | null;
  inDefaultBranch: boolean | null;
  openProcessIds: number[];
  activeThreads: string[];
  decision: "keep" | "remove";
  reasons: string[];
  removed: boolean;
  alreadyDone?: boolean;
}

export interface CleanupReport {
  dryRun: boolean;
  entries: CleanupEntry[];
  errors: string[];
  plan?: { id: string; path: string };
  summary: {
    worktrees: number;
    branches: number;
    removableWorktrees: number;
    removableBranches: number;
    worktreeBytes: number;
    removableBytes: number;
    removedWorktrees: number;
    removedBranches: number;
    reclaimedBytes: number;
  };
}

const cleanupPlanSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  projects: z.array(
    z.object({
      id: z.string(),
      canonicalRoot: z.string(),
      remoteUrl: z.string(),
      baseBranch: z.string(),
    }),
  ),
  entries: z.array(
    z.object({
      projectId: z.string(),
      kind: z.enum(["worktree", "branch"]),
      path: z.string().nullable(),
      branch: z.string().nullable(),
      head: z.string().regex(/^[a-f0-9]{40,64}$/),
    }),
  ),
});
type CleanupPlan = z.infer<typeof cleanupPlanSchema>;

export function cleanupProjectThreadTitles(
  projectRoot: string,
  threads: CleanupThread[],
  now: number,
): string[] {
  const root = canonicalPath(projectRoot);

  return threads
    .filter(
      (thread) =>
        canonicalPath(thread.projectRoot) === root &&
        (thread.running ||
          (thread.lastActivityAt &&
            Date.parse(thread.lastActivityAt) >= now - WORKTREE_CLEANUP_GRACE_MS)),
    )
    .map((thread) => thread.title);
}

export interface CleanupServices {
  readPrs(project: ActiveProject, branch?: string | null): Promise<CleanupPr[]>;
  readThreads(home: string): Promise<CleanupThread[]>;
  readOpenFiles(): Promise<Map<string, Set<number>>>;
}

function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

/** lsof includes protected system files and deleted files; resolve their accessible directory prefix. */
function canonicalOpenPath(path: string): string {
  const absolute = resolve(path);
  let parent = absolute;
  while (true) {
    try {
      return resolve(realpathSync(parent), relative(parent, absolute));
    } catch {
      // The file may be inaccessible or gone. Its closest accessible parent still resolves directory aliases.
    }

    const next = dirname(parent);
    if (next === parent) return absolute;
    parent = next;
  }
}

function inside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

export function cleanupWorktreeAllowed(path: string, projectRoot: string, home: string): boolean {
  const target = canonicalPath(path);

  return (
    inside(target, canonicalPath(join(home, ".t3/worktrees"))) ||
    inside(target, canonicalPath(projectRoot))
  );
}

/** The T3 threads bound to a checkout by its path, or by its branch within the project. */
export function cleanupBoundThreads(
  projectRoot: string,
  path: string | null,
  branch: string | null,
  threads: CleanupThread[],
): CleanupThread[] {
  const root = canonicalPath(projectRoot);
  const target = path ? canonicalPath(path) : null;

  return threads.filter(
    (thread) =>
      (target && thread.worktreePath && canonicalPath(thread.worktreePath) === target) ||
      (target && canonicalPath(thread.projectRoot) === target) ||
      (canonicalPath(thread.projectRoot) === root && branch && thread.branch === branch),
  );
}

export function cleanupThreadTitles(
  projectRoot: string,
  path: string | null,
  branch: string | null,
  threads: CleanupThread[],
): string[] {
  return cleanupBoundThreads(projectRoot, path, branch, threads).map((thread) => thread.title);
}

export function finishedCleanupHead(
  head: string,
  prHead: string | undefined,
  state: CleanupPr["state"] | undefined,
): boolean {
  return (state === "MERGED" || state === "CLOSED") && prHead === head;
}

export async function cleanupFilesChangedRecently(
  path: string,
  now: number,
  reference?: string,
  idleMs = WORKTREE_CLEANUP_GRACE_MS,
): Promise<boolean> {
  const directory = reference ? null : await mkdtemp(join(tmpdir(), "worktree-grace-"));
  const cutoff = reference ?? join(directory!, "cutoff");

  try {
    if (!reference) {
      await writeFile(cutoff, "");
      const time = new Date(now - idleMs);
      await utimes(cutoff, time, time);
    }
    return Boolean(
      (await run("find", [canonicalPath(path), "-newer", cutoff, "-print", "-quit"])).trim(),
    );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function run(command: string, args: string[], cwd?: string, input?: string) {
  const result = await timedCommand(command, args, {
    cwd,
    input,
    timeout: 120_000,
    maxBuffer: 64 * 1024 ** 2,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0)
    throw new Error(`${command}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);

  return result.stdout;
}

async function inspectInBatches<T, R>(items: T[], inspect: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += 4)
    results.push(...(await Promise.all(items.slice(offset, offset + 4).map(inspect))));

  return results;
}

function git(root: string, args: string[]) {
  return run("git", ["-C", root, ...args]);
}

export function parseCleanupWorktrees(output: string): Worktree[] {
  return output
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const fields = block.split("\0");
      const value = (name: string) =>
        fields.find((field) => field.startsWith(`${name} `))?.slice(name.length + 1);
      const path = value("worktree");
      const head = value("HEAD");
      if (!path || !head || !/^[a-f0-9]{40,64}$/.test(head))
        throw new Error("invalid Git worktree record");

      return {
        path,
        head,
        branch: value("branch")?.replace(/^refs\/heads\//, "") ?? null,
        locked: fields.some((field) => /^locked(?: |$)/.test(field)),
        prunable: fields.some((field) => /^prunable(?: |$)/.test(field)),
      };
    });
}

async function worktrees(root: string): Promise<Worktree[]> {
  return parseCleanupWorktrees(await git(root, ["worktree", "list", "--porcelain", "-z"]));
}

async function branches(root: string): Promise<Array<{ branch: string; head: string }>> {
  const output = await git(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    "refs/heads/",
  ]);

  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, head] = line.split("\0");
      if (!ref?.startsWith("refs/heads/") || !head || !/^[a-f0-9]{40,64}$/.test(head))
        throw new Error("invalid Git branch record");

      return { branch: ref.slice("refs/heads/".length), head };
    });
}

export async function cleanupSizeBytes(path: string): Promise<number> {
  const output = await run("du", ["-sk", path]);
  const kib = Number(output.match(/^(\d+)\s/)?.[1]);
  if (!Number.isFinite(kib)) throw new Error(`cannot measure ${path}`);

  return kib * 1024;
}

export function cleanupCachePath(home: string): string {
  return join(home, ".local/state/my-setup/worktree-cleanup.json");
}

/** A durable, small summary for doctor. Full size measurement happens only in the cleanup command. */
export async function writeCleanupCache(report: CleanupReport, home = homedir()): Promise<void> {
  const root = canonicalPath(join(home, ".t3/worktrees"));
  const trees = report.entries.filter(
    (entry) =>
      entry.kind === "worktree" &&
      !entry.removed &&
      entry.path &&
      inside(canonicalPath(entry.path), root),
  );
  const cache = {
    completedAt: new Date().toISOString(),
    t3Worktrees: trees.length,
    t3Bytes: trees.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0),
    unmeasuredWorktrees: trees.filter((entry) => entry.sizeBytes === null).length,
    errors: report.errors.length,
  };
  const path = cleanupCachePath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
}

/** Only one bounded local metadata read. Never traverse worktrees or launch a size-measurement process here. */
export async function cleanupDoctorHint(
  home: string,
  registeredWorktrees: number,
  now = Date.now(),
): Promise<string | null> {
  let cache: z.infer<typeof cleanupCacheSchema> | null = null;
  try {
    const path = cleanupCachePath(home);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isFile() && info.size <= 4096) {
      cache = cleanupCacheSchema.parse(
        JSON.parse(await readFile(path, { encoding: "utf8", signal: AbortSignal.timeout(250) })),
      );
    }
  } catch {
    // Missing, expired, interrupted or invalid reports use the cheap count fallback.
  }

  if (cache && now - Date.parse(cache.completedAt) < CLEANUP_REPORT_MAX_AGE_MS) {
    if (cache.errors || cache.unmeasuredWorktrees)
      return "last worktree-cleanup report was incomplete; rerun worktree-cleanup (dry run)";
    if (cache.t3Bytes >= WORKTREE_SIZE_WARNING_BYTES)
      return `last cleanup report measured ${(cache.t3Bytes / 1024 ** 3).toFixed(1)} GiB in registered T3 worktrees (${cache.completedAt}); run worktree-cleanup --json to review a dry-run plan (removal requires --apply <plan>)`;
    if (registeredWorktrees <= cache.t3Worktrees) return null;
  }
  if (registeredWorktrees >= 5)
    return `${registeredWorktrees} registered T3 worktrees; ${cache ? "cleanup report is stale or worktrees changed" : "no recent size report"}; run worktree-cleanup to measure and review finished work (dry run)`;

  return null;
}

/** Inspect only a disposable copy, including committed WAL frames. Changing or unknown state blocks cleanup. */
export async function readCleanupThreads(home: string): Promise<CleanupThread[]> {
  const source = join(home, ".t3/userdata/statev2.sqlite");
  if (!existsSync(source)) throw new Error(`T3 state is missing: ${source}`);

  const directory = mkdtempSync(join(tmpdir(), "worktree-cleanup-state-"));
  const target = join(directory, "statev2.sqlite");
  const fingerprint = (path: string) => {
    if (!existsSync(path)) return "missing";
    const stat = statSync(path, { bigint: true });

    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  };

  try {
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = [fingerprint(source), fingerprint(`${source}-wal`)];
      copyFileSync(source, target, constants.COPYFILE_FICLONE);
      rmSync(`${target}-wal`, { force: true });
      if (existsSync(`${source}-wal`))
        copyFileSync(`${source}-wal`, `${target}-wal`, constants.COPYFILE_FICLONE);
      stable = before[0] === fingerprint(source) && before[1] === fingerprint(`${source}-wal`);
      if (stable) break;
    }
    if (!stable) throw new Error("T3 state changed while copying; retry after activity settles");

    const db = new Database(target, { readonly: true });
    try {
      // The database also contains large transcripts. Validate only the binding tables cleanup actually reads.
      for (const table of ["projection_threads", "orchestration_v2_projection_threads"]) {
        if (
          db.query<{ quick_check: string }, []>(`PRAGMA quick_check(${table})`).get()
            ?.quick_check !== "ok"
        )
          throw new Error("invalid T3 snapshot");
      }

      const live = new Set(
        db
          .query<{ thread_id: string }, []>(`
        SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
        WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        UNION SELECT thread_id FROM projection_thread_sessions
        WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back', 'stopped', 'disconnected', 'error')
        UNION SELECT thread_id FROM provider_session_runtime
        WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back', 'disconnected', 'stopped')
      `)
          .all()
          .map((row) => row.thread_id),
      );
      const projects = new Map(
        db
          .query<{ project_id: string; workspace_root: string }, []>(
            "SELECT project_id, workspace_root FROM projection_projects",
          )
          .all()
          .map((row) => [row.project_id, row.workspace_root]),
      );
      const running = new Set(
        db
          .query<{ thread_id: string }, []>(`
        SELECT thread_id FROM orchestration_v2_projection_runs WHERE status NOT IN ('idle', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        UNION SELECT thread_id FROM projection_thread_sessions WHERE status NOT IN ('idle', 'ready', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back', 'stopped', 'disconnected', 'error') OR (active_turn_id IS NOT NULL AND status IN ('idle', 'ready'))
        UNION SELECT thread_id FROM provider_session_runtime WHERE status NOT IN ('idle', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back', 'disconnected', 'stopped')
      `)
          .all()
          .map((row) => row.thread_id),
      );
      const activity = new Map(
        db
          .query<{ thread_id: string; at: string | null }, []>(`
        SELECT thread_id, MAX(at) AS at FROM (
          SELECT thread_id, requested_at AS at FROM orchestration_v2_projection_runs
          UNION ALL SELECT thread_id, completed_at AS at FROM orchestration_v2_projection_runs
        ) GROUP BY thread_id
      `)
          .all()
          .map((row) => [row.thread_id, row.at]),
      );
      const current = db
        .query<{ thread_id: string; project_id: string; payload_json: string }, []>(
          "SELECT thread_id, project_id, payload_json FROM orchestration_v2_projection_threads",
        )
        .all()
        .map((row) => ({
          id: row.thread_id,
          projectId: row.project_id,
          data: threadBindingSchema.parse(JSON.parse(row.payload_json)),
        }));
      const legacy = db
        .query<Record<string, unknown>, []>("SELECT * FROM projection_threads")
        .all()
        .filter((row) => !current.some((thread) => thread.id === row.thread_id))
        .map((row) => ({
          id: String(row.thread_id),
          projectId: String(row.project_id),
          data: {
            title: row.title,
            worktreePath: row.worktree_path,
            branch: row.branch,
            archivedAt: row.archived_at,
            deletedAt: row.deleted_at,
            settledAt: row.settled_at,
            settledOverride: row.settled_override,
            unsettledAt: row.unsettled_at,
            updatedAt: typeof row.updated_at === "string" ? row.updated_at : undefined,
          },
        }));
      const active: CleanupThread[] = [];
      for (const { id, projectId, data } of [...current, ...legacy]) {
        // Settlement hides a thread from the inbox; it does not release its agent or checkout.
        if (!live.has(id) && (data.archivedAt || data.deletedAt)) continue;
        const projectRoot = projects.get(projectId);
        if (
          !projectRoot ||
          typeof data.title !== "string" ||
          (data.worktreePath != null && typeof data.worktreePath !== "string") ||
          (data.branch != null && typeof data.branch !== "string")
        )
          throw new Error("unknown T3 thread binding schema");

        active.push({
          title: data.title,
          projectRoot,
          worktreePath: data.worktreePath ?? null,
          branch: data.branch ?? null,
          lastActivityAt: activity.get(id) ?? data.updatedAt,
          running: running.has(id),
        });
      }
      const launching = db
        .query<
          {
            title: string;
            project_id: string;
            worktree_path: string | null;
            branch: string | null;
          },
          []
        >(`
        SELECT title, project_id, worktree_path, branch FROM orchestration_v2_thread_launch_workflows
        WHERE status NOT IN ('completed', 'failed', 'cancelled')
      `)
        .all();
      for (const row of launching) {
        const projectRoot = projects.get(row.project_id);
        if (!projectRoot) throw new Error("unknown T3 launch project");

        active.push({
          title: row.title,
          projectRoot,
          worktreePath: row.worktree_path,
          branch: row.branch,
          running: true,
        });
      }

      return active;
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function parseCleanupOpenFiles(output: string): Map<string, Set<number>> {
  const paths = new Map<string, Set<number>>();
  let pid: number | null = null;
  for (const field of output.split("\0")) {
    const record = field.replace(/^\n/, "");
    if (record.startsWith("p")) pid = Number(record.slice(1));
    if (!record.startsWith("n/") || pid === null || !Number.isSafeInteger(pid)) continue;
    const path = canonicalOpenPath(record.slice(1));
    const ids = paths.get(path) ?? new Set<number>();
    ids.add(pid);
    paths.set(path, ids);
  }

  return paths;
}

const defaultServices: CleanupServices = {
  readThreads: readCleanupThreads,
  async readOpenFiles() {
    // All visible processes, including cwd and memory-mapped files. A diagnostic means visibility is incomplete.
    const result = await timedCommand("lsof", ["-nP", "-Fpn0"], {
      timeout: 30_000,
      maxBuffer: 64 * 1024 ** 2,
    });
    if (result.exitCode !== 0 || result.stderr.trim())
      throw new Error(
        `cannot inspect open files: ${result.stderr.trim() || `lsof exit ${result.exitCode}`}`,
      );

    return parseCleanupOpenFiles(result.stdout);
  },
  async readPrs(project, branch) {
    const match = project.remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!match) throw new Error(`unsupported GitHub remote: ${project.remoteUrl}`);
    const head = branch ? `&head=${encodeURIComponent(`${match[1].split("/")[0]}:${branch}`)}` : "";
    const output = await run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${match[1]}/pulls?state=all&per_page=100${head}`,
    ]);
    const pages: Array<
      Array<{
        number: number;
        state: string;
        merged_at: string | null;
        closed_at: string | null;
        updated_at: string;
        head: { ref: string; sha: string; repo: { full_name: string } | null };
      }>
    > = JSON.parse(output);

    // Exclude forks that happen to use the same branch name.
    return pages
      .flat()
      .filter((pr) => pr.head.repo?.full_name.toLowerCase() === match[1].toLowerCase())
      .map((pr) => ({
        number: pr.number,
        state: pr.merged_at ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
        branch: pr.head.ref,
        head: pr.head.sha,
        updatedAt: pr.updated_at,
        finishedAt: pr.merged_at ?? pr.closed_at,
      }));
  },
};

interface SafetySnapshot {
  threads: CleanupThread[] | null;
  files: Map<string, Set<number>> | null;
  errors: string[];
}

async function safetySnapshot(services: CleanupServices, home: string): Promise<SafetySnapshot> {
  const [threads, files] = await Promise.allSettled([
    services.readThreads(home).then((threads) =>
      threads.map((thread) => ({
        ...thread,
        projectRoot: canonicalPath(thread.projectRoot),
        worktreePath: thread.worktreePath ? canonicalPath(thread.worktreePath) : null,
      })),
    ),
    services.readOpenFiles(),
  ]);

  return {
    threads: threads.status === "fulfilled" ? threads.value : null,
    files: files.status === "fulfilled" ? files.value : null,
    errors: [threads, files].flatMap((result) =>
      result.status === "rejected" ? [String(result.reason)] : [],
    ),
  };
}

function usage(
  project: ActiveProject,
  path: string | null,
  branch: string | null,
  safety: SafetySnapshot,
) {
  const target = path ? canonicalPath(path) : null;
  const activeThreads = cleanupThreadTitles(
    project.canonicalRoot,
    path,
    branch,
    safety.threads ?? [],
  );
  const openProcessIds = target
    ? [
        ...new Set(
          [...(safety.files ?? [])].flatMap(([open, ids]) =>
            inside(open, target) ? [...ids] : [],
          ),
        ),
      ]
    : [];

  return { activeThreads, openProcessIds };
}

/** Fetch into disposable Git storage; canonical objects are read through alternates, and project refs stay untouched. */
async function remoteSnapshot(
  project: ActiveProject,
  dir: string,
  prs: CleanupPr[],
  tips: Array<{ head: string }>,
): Promise<string> {
  if (
    (await git(project.canonicalRoot, ["rev-parse", "--is-shallow-repository"])).trim() !== "false"
  )
    throw new Error("shallow checkout cannot prove commit reachability");
  const remote = (await git(project.canonicalRoot, ["remote", "get-url", "origin"])).trim();
  const normalize = (url: string) =>
    url
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
  if (normalize(remote) !== normalize(project.remoteUrl))
    throw new Error("origin differs from the configured active project");
  const defaultRef = await run("git", ["ls-remote", "--symref", remote, "HEAD"]);
  if (!defaultRef.split("\n").includes(`ref: refs/heads/${project.baseBranch}\tHEAD`))
    throw new Error(
      "remote default branch differs from the configured base branch or cannot be verified",
    );

  const snapshot = join(dir, project.id);
  await run("git", ["init", "--bare", snapshot]);
  const objects = (await git(project.canonicalRoot, ["rev-parse", "--git-path", "objects"])).trim();
  await writeFile(
    join(snapshot, "objects/info/alternates"),
    `${isAbsolute(objects) ? objects : resolve(project.canonicalRoot, objects)}\n`,
  );
  await run(
    "git",
    ["-C", snapshot, "update-ref", "--stdin"],
    undefined,
    `${tips.map(({ head }, index) => `update refs/local/${index} ${head}`).join("\n")}\n`,
  );

  // Include historical PR heads: squash merges and deleted remote branches remain published at refs/pull/N/head.
  const refspecs = [
    ...new Set(
      prs
        .filter((pr) => pr.state !== "OPEN" && tips.some((tip) => tip.head === pr.head))
        .map((pr) => `+refs/pull/${pr.number}/head:refs/pull/${pr.number}/head`),
    ),
  ];
  await git(snapshot, [
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    "--no-tags",
    "--filter=blob:none",
    remote,
    "+refs/heads/*:refs/remotes/origin/*",
    ...refspecs,
  ]);
  await git(snapshot, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${project.baseBranch}^{commit}`,
  ]);

  return snapshot;
}

async function inspectEntry(
  project: ActiveProject,
  item: { head: string; branch: string | null },
  tree: Worktree | null,
  prs: CleanupPr[],
  remote: string | null,
  safety: SafetySnapshot,
  home: string,
  now: number,
  graceReference: string,
): Promise<CleanupEntry> {
  const matching = prs
    .filter((pr) => pr.branch === item.branch)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pr = matching.find((candidate) => candidate.state === "OPEN") ?? matching[0] ?? null;
  const entry: CleanupEntry = {
    kind: tree ? "worktree" : "branch",
    project: project.name,
    path: tree?.path ?? null,
    branch: item.branch,
    head: item.head,
    pr,
    clean: null,
    unpushedCommits: null,
    sizeBytes: tree ? null : 0,
    inDefaultBranch: null,
    ...usage(project, tree?.path ?? null, item.branch, safety),
    decision: "keep",
    reasons: [],
    removed: false,
  };
  const reasons = entry.reasons;
  if (tree) {
    if (!tree.branch) reasons.push("detached-head worktrees are never removed");
    if (!cleanupWorktreeAllowed(tree.path, project.canonicalRoot, home))
      reasons.push("worktree is outside the T3 worktree directory and project root");
    if (canonicalPath(tree.path) === canonicalPath(project.canonicalRoot))
      reasons.push("canonical checkout");
    if (tree.locked) reasons.push("worktree is locked");
    if (tree.prunable || !existsSync(tree.path))
      reasons.push("worktree is missing or prunable; inspect registration separately");
    if (existsSync(tree.path)) {
      try {
        entry.sizeBytes = await cleanupSizeBytes(tree.path);
        if (
          canonicalPath((await git(tree.path, ["rev-parse", "--show-toplevel"])).trim()) !==
          canonicalPath(tree.path)
        )
          throw new Error("checkout path mismatch");
        if ((await git(tree.path, ["rev-parse", "HEAD"])).trim() !== item.head)
          throw new Error("HEAD changed during inspection");
        entry.clean =
          (
            await git(tree.path, [
              "status",
              "--porcelain=v1",
              "-z",
              "--untracked-files=all",
              "--ignore-submodules=none",
            ])
          ).length === 0;
        if (!entry.clean) reasons.push("uncommitted or untracked changes");
        if (await cleanupFilesChangedRecently(tree.path, now, graceReference))
          reasons.push("files changed within the four-hour grace period");
      } catch (error) {
        reasons.push(`cannot inspect checkout: ${String(error)}`);
      }
    }
  }
  if (item.branch === project.baseBranch) reasons.push("default branch");
  if (safety.threads === null) reasons.push("T3 state unavailable");
  if (safety.files === null) reasons.push("open-file inspection unavailable");
  if (entry.activeThreads.length)
    reasons.push(`active T3 thread: ${entry.activeThreads.join(", ")}`);
  if (entry.openProcessIds.length)
    reasons.push(`files open by process: ${entry.openProcessIds.join(", ")}`);
  const busy = cleanupProjectThreadTitles(project.canonicalRoot, safety.threads ?? [], now);
  if (busy.length) reasons.push(`recently active or running T3 project: ${busy.join(", ")}`);

  if (!remote) reasons.push("remote or PR evidence unavailable");
  else {
    try {
      const ancestry = await execa(
        "git",
        [
          "-C",
          remote,
          "merge-base",
          "--is-ancestor",
          item.head,
          `refs/remotes/origin/${project.baseBranch}`,
        ],
        { reject: false },
      );
      if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1)
        throw new Error("cannot prove default-branch ancestry");
      entry.inDefaultBranch = ancestry.exitCode === 0;
      const committedAt =
        Number((await git(remote, ["show", "-s", "--format=%ct", item.head])).trim()) * 1000;
      if (!Number.isFinite(committedAt)) throw new Error("cannot prove commit age");
      if (committedAt >= now - WORKTREE_CLEANUP_GRACE_MS)
        reasons.push("last commit is within the four-hour grace period");
      entry.unpushedCommits = Number(
        (
          await git(remote, [
            "rev-list",
            "--count",
            item.head,
            "--not",
            "--remotes=origin",
            "--glob=refs/pull/*",
          ])
        ).trim(),
      );
      if (!Number.isSafeInteger(entry.unpushedCommits))
        throw new Error("cannot count unpublished commits");
      if (entry.unpushedCommits > 0)
        reasons.push(
          `${entry.unpushedCommits} commits missing from remote heads and published PR refs`,
        );
      if (pr?.state === "OPEN") reasons.push(`PR #${pr.number} is open`);
      else if (!finishedCleanupHead(item.head, pr?.head, pr?.state))
        reasons.push(
          pr
            ? "local head differs from the finished PR head"
            : "no finished PR; default-branch ancestry alone does not prove finished work",
        );
      else {
        const finishedAt = Date.parse(pr!.finishedAt ?? pr!.updatedAt);
        if (!Number.isFinite(finishedAt)) throw new Error("cannot prove finished PR age");
        if (finishedAt >= now - WORKTREE_CLEANUP_GRACE_MS)
          reasons.push(`PR #${pr!.number} finished within the four-hour grace period`);
      }
    } catch (error) {
      reasons.push(`cannot inspect commits: ${String(error)}`);
    }
  }
  if (reasons.length === 0) {
    entry.decision = "remove";
    reasons.push(
      `PR #${pr!.number} is ${pr!.state.toLowerCase()} at this head; all safety checks passed`,
    );
  }

  return entry;
}

/** A current remote ref must still publish this entire head, even if refs vanished during the audit. */
async function verifyRemotePublication(project: ActiveProject, snapshot: string, head: string) {
  const refs = (
    await git(snapshot, [
      "for-each-ref",
      `--contains=${head}`,
      "--format=%(refname)%00%(objectname)",
      "refs/remotes/origin/",
      "refs/pull/",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, oid] = line.split("\0");

      return { ref: ref.replace(/^refs\/remotes\/origin\//, "refs/heads/"), oid };
    });
  const current = (
    await run("git", [
      "ls-remote",
      "--symref",
      project.remoteUrl,
      "HEAD",
      ...refs.map(({ ref }) => ref),
    ])
  ).split("\n");
  if (!current.includes(`ref: refs/heads/${project.baseBranch}\tHEAD`))
    throw new Error("remote default branch changed");
  if (!refs.some(({ ref, oid }) => current.includes(`${oid}\t${ref}`)))
    throw new Error("no current remote ref proves this head is published; run a fresh audit");
}

function retain(entry: CleanupEntry, reason: string) {
  if (entry.decision === "remove") entry.reasons = [];
  entry.decision = "keep";
  entry.reasons.push(reason);
}

function summarize(report: CleanupReport) {
  const trees = report.entries.filter((entry) => entry.kind === "worktree");
  const refs = report.entries.filter((entry) => entry.kind === "branch");
  report.summary = {
    worktrees: trees.length,
    branches: refs.length,
    removableWorktrees: trees.filter((entry) => entry.decision === "remove").length,
    removableBranches: refs.filter((entry) => entry.decision === "remove").length,
    worktreeBytes: trees.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    removableBytes: trees
      .filter((entry) => entry.decision === "remove")
      .reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    removedWorktrees: trees.filter((entry) => entry.removed).length,
    removedBranches: refs.filter((entry) => entry.removed).length,
    reclaimedBytes: trees
      .filter((entry) => entry.removed)
      .reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
  };
}

export async function cleanupWorktrees(
  options: {
    apply?: string;
    home?: string;
    now?: number;
    projects?: ActiveProject[];
    services?: CleanupServices;
  } = {},
): Promise<CleanupReport> {
  const {
    apply,
    home = homedir(),
    now = Date.now(),
    projects = ACTIVE_PROJECTS,
    services = defaultServices,
  } = options;
  const directory = await mkdtemp(join(tmpdir(), "worktree-cleanup-git-"));
  const graceReference = join(directory, "grace-cutoff");
  await writeFile(graceReference, "");
  const cutoff = new Date(now - WORKTREE_CLEANUP_GRACE_MS);
  await utimes(graceReference, cutoff, cutoff);
  const report: CleanupReport = {
    dryRun: !apply,
    entries: [],
    errors: [],
    summary: {} as CleanupReport["summary"],
  };

  try {
    let plan: CleanupPlan | undefined;
    if (apply !== undefined) {
      if (typeof apply !== "string" || !apply)
        throw new Error("--apply requires a saved dry-run plan ID or path");
      const path = /^[0-9a-f-]{36}$/i.test(apply)
        ? join(home, ".local/state/my-setup/cleanup-plans", `${apply}.json`)
        : resolve(apply);
      plan = cleanupPlanSchema.parse(JSON.parse(await readFile(path, "utf8")));
      for (const saved of plan.projects) {
        const project = projects.find((project) => project.id === saved.id);
        if (
          !project ||
          canonicalPath(project.canonicalRoot) !== canonicalPath(saved.canonicalRoot) ||
          project.remoteUrl !== saved.remoteUrl ||
          project.baseBranch !== saved.baseBranch
        )
          throw new Error("plan project configuration changed; create a new dry run");
      }
      if (
        plan.entries.some(
          (entry) => !plan!.projects.some((project) => project.id === entry.projectId),
        )
      )
        throw new Error("plan contains an unknown project");
      report.plan = { id: plan.id, path };
    }
    const safety = await safetySnapshot(services, home);
    report.errors.push(...safety.errors);
    for (const project of projects) {
      if (!existsSync(project.canonicalRoot)) {
        report.errors.push(`${project.name}: canonical checkout is missing`);
        continue;
      }
      try {
        const [trees, refs] = await Promise.all([
          worktrees(project.canonicalRoot),
          branches(project.canonicalRoot),
        ]);
        let prs: CleanupPr[] = [];
        let remote: string | null = null;
        try {
          prs = await services.readPrs(project);
          remote = await remoteSnapshot(project, directory, prs, [...refs, ...trees]);
        } catch (error) {
          report.errors.push(`${project.name}: ${String(error)}`);
        }

        const planned = plan?.entries.filter((entry) => entry.projectId === project.id);
        const plannedTree = (tree: Worktree) =>
          planned?.find(
            (entry) =>
              entry.kind === "worktree" &&
              entry.path &&
              canonicalPath(entry.path) === canonicalPath(tree.path),
          );
        const plannedBranch = (branch: string) =>
          planned?.find((entry) => entry.kind === "branch" && entry.branch === branch);
        const treeEntries = await inspectInBatches(
          plan ? trees.filter((tree) => plannedTree(tree)) : trees,
          async (tree) => {
            const entry = await inspectEntry(
              project,
              tree,
              tree,
              prs,
              remote,
              safety,
              home,
              now,
              graceReference,
            );
            const saved = plannedTree(tree);
            if (saved && (saved.head !== tree.head || saved.branch !== tree.branch))
              retain(entry, "planned worktree head or branch changed; create a new plan");
            return entry;
          },
        );
        const refEntries = await inspectInBatches(
          plan ? refs.filter((ref) => plannedBranch(ref.branch)) : refs,
          async (ref) => {
            const entry = await inspectEntry(
              project,
              ref,
              null,
              prs,
              remote,
              safety,
              home,
              now,
              graceReference,
            );
            const saved = plannedBranch(ref.branch);
            if (saved && saved.head !== ref.head)
              retain(entry, "planned branch head changed; create a new plan");
            const bound = trees.filter((tree) => tree.branch === ref.branch);
            entry.clean = bound.length
              ? treeEntries
                  .filter((tree) => tree.branch === ref.branch)
                  .every((tree) => tree.clean === true)
              : null;
            if (
              bound.some(
                (tree) =>
                  !treeEntries.some(
                    (entry) => entry.path === tree.path && entry.decision === "remove",
                  ),
              )
            )
              retain(entry, "branch belongs to a kept or unplanned worktree");
            return entry;
          },
        );
        report.entries.push(...treeEntries, ...refEntries);
        for (const saved of planned ?? []) {
          if (
            (saved.kind === "branch" && refs.some((ref) => ref.branch === saved.branch)) ||
            (saved.kind === "worktree" &&
              trees.some(
                (tree) => saved.path && canonicalPath(tree.path) === canonicalPath(saved.path),
              ))
          )
            continue;
          report.entries.push({
            kind: saved.kind,
            project: project.name,
            path: saved.path,
            branch: saved.branch,
            head: saved.head,
            pr: null,
            clean: null,
            unpushedCommits: null,
            sizeBytes: saved.kind === "branch" ? 0 : null,
            inDefaultBranch: null,
            openProcessIds: [],
            activeThreads: [],
            decision: "keep",
            reasons: [
              saved.kind === "branch"
                ? "planned branch is already gone; already done"
                : "planned worktree is no longer registered; no directory removed",
            ],
            removed: false,
            alreadyDone: saved.kind === "branch" || !saved.path || !existsSync(saved.path),
          });
        }
        if (!apply || !remote) continue;

        // Serialize this command's applies. Other agents are guarded by fresh bindings, HEAD/status and Git's own checks.
        const common = (await git(project.canonicalRoot, ["rev-parse", "--git-common-dir"])).trim();
        const lock = join(resolve(project.canonicalRoot, common), "worktree-cleanup.lock");
        await mkdir(lock);
        try {
          for (const entry of treeEntries.filter((entry) => entry.decision === "remove")) {
            try {
              const freshSafety = await safetySnapshot(services, home);
              const current = (await worktrees(project.canonicalRoot)).find(
                (tree) => tree.path === entry.path,
              );
              if (!current || current.head !== entry.head || current.branch !== entry.branch)
                throw new Error("worktree binding or HEAD changed since inspection");
              const fresh = await inspectEntry(
                project,
                current,
                current,
                await services.readPrs(project, current.branch),
                remote,
                freshSafety,
                home,
                now,
                graceReference,
              );
              if (fresh.decision === "keep") {
                retain(entry, `recheck: ${fresh.reasons.join("; ")}`);
                continue;
              }
              // No --force: Git refuses dirty/locked worktrees and submodules it cannot safely remove.
              await verifyRemotePublication(project, remote, entry.head);
              await git(project.canonicalRoot, ["worktree", "remove", "--", current.path]);
              entry.removed = true;
              entry.sizeBytes = fresh.sizeBytes;
            } catch (error) {
              retain(entry, `removal refused: ${String(error)}`);
              report.errors.push(`${project.name}: ${String(error)}`);
            }
          }
          for (const entry of refEntries.filter((entry) => entry.decision === "remove")) {
            try {
              const currentTrees = await worktrees(project.canonicalRoot);
              if (currentTrees.some((tree) => tree.branch === entry.branch)) {
                retain(entry, "branch belongs to a kept worktree");
                continue;
              }
              const freshSafety = await safetySnapshot(services, home);
              const currentHead = (await branches(project.canonicalRoot)).find(
                (ref) => ref.branch === entry.branch,
              )?.head;
              if (!currentHead) {
                retain(entry, "planned branch is already gone; already done");
                entry.alreadyDone = true;
                continue;
              }
              if (currentHead !== entry.head)
                throw new Error("branch head changed since inspection");
              const fresh = await inspectEntry(
                project,
                { head: currentHead, branch: entry.branch },
                null,
                await services.readPrs(project, entry.branch),
                remote,
                freshSafety,
                home,
                now,
                graceReference,
              );
              if (fresh.decision === "keep") {
                retain(entry, `recheck: ${fresh.reasons.join("; ")}`);
                continue;
              }
              // Compare-and-delete prevents losing a concurrent commit. Worktree/thread bindings were just rechecked.
              await verifyRemotePublication(project, remote, entry.head);
              if (
                (await worktrees(project.canonicalRoot)).some(
                  (tree) => tree.branch === entry.branch,
                )
              )
                throw new Error("branch was bound to a worktree during rechecking");
              await git(project.canonicalRoot, [
                "update-ref",
                "-d",
                `refs/heads/${entry.branch}`,
                entry.head,
              ]);
              entry.removed = true;
            } catch (error) {
              if (
                !(await branches(project.canonicalRoot)).some((ref) => ref.branch === entry.branch)
              ) {
                retain(entry, "planned branch is already gone; already done");
                entry.alreadyDone = true;
                continue;
              }
              retain(entry, `deletion refused: ${String(error)}`);
              report.errors.push(`${project.name}: ${String(error)}`);
            }
          }
        } finally {
          await rm(lock, { recursive: true });
        }
      } catch (error) {
        report.errors.push(`${project.name}: ${String(error)}`);
      }
    }
    if (!apply) {
      const id = randomUUID();
      const path = join(home, ".local/state/my-setup/cleanup-plans", `${id}.json`);
      const saved = {
        version: 1,
        id,
        createdAt: new Date(now).toISOString(),
        projects: projects.map(({ id, canonicalRoot, remoteUrl, baseBranch }) => ({
          id,
          canonicalRoot,
          remoteUrl,
          baseBranch,
        })),
        entries: report.entries
          .filter((entry) => entry.decision === "remove")
          .map((entry) => ({
            projectId: projects.find((project) => project.name === entry.project)!.id,
            kind: entry.kind,
            path: entry.path,
            branch: entry.branch,
            head: entry.head,
          })),
      };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      report.plan = { id, path };
    }
  } catch (error) {
    report.errors.push(String(error));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  summarize(report);

  return report;
}
