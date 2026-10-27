import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  rmdir,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import { z } from "zod";

import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { MAC_WATCHER } from "../../config/mac-watcher";
import { readQueueState } from "./queue-store";
import { timedCommand } from "./timed-command";
import {
  cleanupBoundThreads,
  cleanupProjectThreadTitles,
  cleanupWorktreeAllowed,
  readCleanupThreads,
  type CleanupThread,
  cleanupFilesChangedRecently,
  WORKTREE_CLEANUP_GRACE_MS,
} from "./worktree-cleanup";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ARCHIVE_COPY_TIMEOUT_MS = 5 * 60 * 1000;
const SLOW_STEP_SECONDS = 60;

/** Include this setup repository without making it a product in ACTIVE_PROJECTS. */
export const STORAGE_WORKTREE_PROJECTS = [
  ...ACTIVE_PROJECTS,
  { name: "my-setup", canonicalRoot: join(import.meta.dir, "../.."), baseBranch: "main" },
];

// =============================================================================
// Rules
// =============================================================================

export interface AgedEntry {
  path: string;
  mtimeMs: number;
}

export function olderThan<T extends AgedEntry>(entries: T[], days: number, now: number): T[] {
  return entries.filter((entry) => now - entry.mtimeMs > days * DAY_MS);
}

/** Children past `days`, plus children whose project is gone once untouched for `projectGoneHours`. */
export function staleChildren<T extends AgedEntry & { projectGone: boolean }>(
  children: T[],
  options: { days: number; projectGoneHours?: number; now: number },
): T[] {
  return children.filter((child) => {
    const age = options.now - child.mtimeMs;
    const gone =
      child.projectGone &&
      options.projectGoneHours !== undefined &&
      age > options.projectGoneHours * HOUR_MS;
    return age > options.days * DAY_MS || gone;
  });
}

/** The project path an Xcode DerivedData `info.plist` records, or undefined when it records none. */
export function xcodeWorkspacePath(plist: string): string | undefined {
  const path = plist.match(/<key>WorkspacePath<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return path?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name]);
}

/** True when a running process holds the path itself or anything inside it open, including as its working directory. */
export function isInUse(path: string, openPaths: Set<string>): boolean {
  if (openPaths.has(path)) return true;
  const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
  for (const open of openPaths) {
    if (open.startsWith(prefix)) return true;
  }
  return false;
}

export interface WorktreeFacts {
  path: string;
  branch: string | undefined;
  head: string;
  locked: boolean;
  dirty: boolean;
  inUse: boolean;
  lastActivityMs: number;
  mergedIntoBase: boolean;
  lastCommitMs: number;
  recentFiles: boolean;
  filesChangedWithinIdleWindow?: boolean;
  filesChangedWithinDay?: boolean;
  prFinishedAt: string | null;
  pr: { state: "OPEN" | "MERGED" | "CLOSED"; headRefOid: string } | undefined;
  /** Titles of the T3 threads still bound to the worktree that are not running, such as a settled thread. */
  threads?: string[];
}

export type WorktreeDecision = { remove: true; archive?: true } | { remove: false; reason: string };

/**
 * Finished branches require a verified archive before removal. Other branches must be clean and keep their refs;
 * detached heads must be clean and untouched for a full day. Process, lock, and recent activity protections apply first.
 */
export function decideWorktree(
  facts: WorktreeFacts,
  now: number,
  idleDays: { landed: number; abandoned: number; thread: number },
): WorktreeDecision {
  if (facts.locked) return { remove: false, reason: "locked" };
  if (facts.inUse) return { remove: false, reason: "in use by a running process" };

  // Git activity during the run itself can land after `now`.
  const idle = Math.max(0, now - facts.lastActivityMs) / DAY_MS;
  const active = `active ${Math.floor(idle)}d ago`;
  const prFinished = Boolean(
    facts.branch && (facts.pr?.state === "MERGED" || facts.pr?.state === "CLOSED"),
  );
  if (
    facts.recentFiles ||
    facts.lastCommitMs >= now - WORKTREE_CLEANUP_GRACE_MS ||
    (prFinished &&
      (!facts.prFinishedAt ||
        !Number.isFinite(Date.parse(facts.prFinishedAt)) ||
        Date.parse(facts.prFinishedAt) >= now - WORKTREE_CLEANUP_GRACE_MS))
  )
    return { remove: false, reason: "four-hour activity grace period" };
  if (prFinished) {
    return idle < idleDays.landed
      ? { remove: false, reason: `landed, ${active}` }
      : { remove: true, archive: true };
  }

  if (facts.dirty) return { remove: false, reason: "uncommitted changes" };
  if (!facts.branch)
    return idle < 1 || facts.filesChangedWithinDay
      ? { remove: false, reason: "detached HEAD active within 24 hours" }
      : { remove: true };
  if (facts.pr?.state === "OPEN") return { remove: false, reason: "PR open" };
  // Clean and wholly on the default branch, like a clean detached head: nothing main lacks, and the branch stays.
  if (facts.mergedIntoBase)
    return idle < 1 || facts.filesChangedWithinDay
      ? { remove: false, reason: "branch on default branch active within 24 hours" }
      : { remove: true };
  if (facts.filesChangedWithinIdleWindow)
    return { remove: false, reason: "files changed within idle window" };
  if (facts.threads?.length) {
    if (idle < idleDays.thread)
      return { remove: false, reason: `T3 thread: ${facts.threads.join(", ")}` };
  } else if (idle < idleDays.abandoned) return { remove: false, reason: active };
  return { remove: true };
}

/** Git-ignored build output and installed dependencies; tracked descendants always protect the whole folder. */
export function nativeBuildCandidates(
  ignoredPaths: string[],
  rule: { ignored: RegExp; dependencies: { dir: RegExp } },
  trackedPaths: string[] = [],
): { outputs: string[]; dependencyDirs: string[] } {
  const safe = ignoredPaths.filter(
    (path) =>
      path.endsWith("/") &&
      !trackedPaths.some((tracked) => tracked === path.slice(0, -1) || tracked.startsWith(path)),
  );

  return {
    outputs: safe.filter((path) => rule.ignored.test(path)),
    dependencyDirs: safe.filter((path) => rule.dependencies.dir.test(path)),
  };
}

/** Installed Codex versions to delete: every one but the current version and the newest others up to `keep` in all. */
export function codexReleasesToDelete<T extends AgedEntry>(
  releases: T[],
  current: string,
  keep: number,
): T[] {
  const others = releases.filter((release) => basename(release.path) !== current);
  return others.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(Math.max(0, keep - 1));
}

export interface CodexThreadFacts {
  id: string;
  updatedMs: number;
  /** The thread's session file is still in Codex's folder, so the archive has not taken it yet. */
  sessionFileExists: boolean;
}

/** Codex threads idle past `idleDays` whose session file is gone from Codex's folder, so deleting one never takes the file. */
export function codexThreadsToDelete(
  threads: CodexThreadFacts[],
  options: { idleDays: number; now: number },
): CodexThreadFacts[] {
  return threads.filter(
    (thread) =>
      !thread.sessionFileExists && options.now - thread.updatedMs > options.idleDays * DAY_MS,
  );
}

export interface TempEntry extends AgedEntry {
  name: string;
  kind: "file" | "directory" | "other";
  ownedByUser: boolean;
  /** A socket sits in the folder itself, so a live service may still listen there. */
  holdsSocket: boolean;
}

/** Temp entries agent runs left behind: this user's plain files and folders that no live service may still need. */
export function tempLeftovers(
  entries: TempEntry[],
  options: {
    days: number;
    skip: RegExp;
    now: number;
    toolCaches?: { days: number; match: RegExp };
  },
): TempEntry[] {
  return entries.filter(
    (entry) =>
      options.now - entry.mtimeMs >
        (options.toolCaches?.match.test(entry.name) ? options.toolCaches.days : options.days) *
          DAY_MS &&
      entry.kind !== "other" &&
      entry.ownedByUser &&
      !entry.holdsSocket &&
      !options.skip.test(entry.name),
  );
}

/** Reusable caches may hide newer files or service leases several levels below an old top-level directory. */
export async function toolCacheIdle(path: string, now: number, days: number): Promise<boolean> {
  if (await cleanupFilesChangedRecently(path, now, undefined, days * DAY_MS)) return false;
  // Dependency manifests are data in disposable tool workspaces, not process leases.
  const dependencyLocks = [
    "composer.lock",
    "bun.lock",
    "yarn.lock",
    "Cargo.lock",
    "Gemfile.lock",
    "uv.lock",
    "poetry.lock",
  ];
  const protectedFiles = await run("find", [
    path,
    "(",
    "-type",
    "s",
    "-o",
    "(",
    "(",
    "-name",
    "*.lock",
    "-o",
    "-name",
    "*.pid",
    ")",
    ...dependencyLocks.flatMap((name) => ["!", "-name", name]),
    ")",
    ")",
    "-print",
    "-quit",
  ]);
  if (protectedFiles.exitCode !== 0) throw new Error(`cannot inspect tool cache ${path}`);
  return protectedFiles.stdout.trim() === "";
}

/** Direct children of `dir` that a running process holds open or works in, found in one pass over the open paths. */
export function childrenInUse(dir: string, openPaths: Set<string>): Set<string> {
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  const children = new Set<string>();
  for (const open of openPaths) {
    if (open.startsWith(prefix))
      children.add(join(dir, open.slice(prefix.length).split(sep)[0] ?? ""));
  }
  return children;
}

export interface DeviceFacts extends AgedEntry {
  kind: "simulator" | "emulator";
  /** Simulator UDID or emulator AVD name. */
  id: string;
  name: string;
  running: boolean;
}

/** Simulators and emulators nobody uses: not running, unused for `days`, and not a device to keep. */
export function devicesToDelete(
  devices: DeviceFacts[],
  options: { days: number; keep: RegExp; now: number },
): DeviceFacts[] {
  return olderThan(devices, options.days, options.now).filter(
    (device) => !device.running && !options.keep.test(device.name),
  );
}

export interface TestDatabaseFacts {
  name: string;
  /** The checkouts the suite recorded when it built the database; empty when it recorded none. */
  checkouts: string[];
  touchedMs: number;
  bytes: number;
  inUse: boolean;
}

/** A parallel worker's copy is named after the database it was made from. */
export function testDatabaseFamily(name: string): string {
  return name.replace(/_test_\d+$/, "");
}

/**
 * Matching test databases whose checkout is gone or whose active-project family is idle, including parallel copies.
 * A connection to any member protects the whole family, including sleeping connections between test queries.
 */
export function testDatabasesToDrop(
  databases: TestDatabaseFacts[],
  options: {
    now: number;
    idleDays: number;
    prefixes: string[];
    checkoutExists: (path: string) => boolean;
  },
): TestDatabaseFacts[] {
  const families = new Map<string, TestDatabaseFacts[]>();
  for (const database of databases) {
    if (
      !/^\w+$/.test(database.name) ||
      !MAC_WATCHER.storage.testDatabases.match.test(database.name)
    )
      continue;
    const family = testDatabaseFamily(database.name);
    families.set(family, [...(families.get(family) ?? []), database]);
  }

  return [...families.entries()].flatMap(([family, members]) => {
    if (members.some((member) => member.inUse)) return [];

    const checkouts = members.flatMap((member) => member.checkouts);
    if (checkouts.length > 0 && !checkouts.some(options.checkoutExists)) return members;

    if (!options.prefixes.some((prefix) => family.startsWith(prefix))) return [];
    const touched = Math.max(...members.map((member) => member.touchedMs));
    return options.now - touched >= options.idleDays * DAY_MS ? members : [];
  });
}

// =============================================================================
// Report
// =============================================================================

const reportSchema = z.object({
  at: z.string(),
  dryRun: z.boolean(),
  freedBytes: z.number(),
  deleted: z.array(z.object({ path: z.string(), bytes: z.number() })),
  archived: z.object({ files: z.number(), bytes: z.number() }),
  lowSpaceArchived: z
    .object({ files: z.number(), bytes: z.number() })
    .default({ files: 0, bytes: 0 }),
  browserCachesPruned: z
    .object({ files: z.number(), bytes: z.number() })
    .default({ files: 0, bytes: 0 }),
  temp: z.object({ entries: z.number(), bytes: z.number() }).default({ entries: 0, bytes: 0 }),
  worktreesRemoved: z.array(z.object({ path: z.string(), bytes: z.number() })),
  worktreesArchived: z.array(z.object({ path: z.string(), archive: z.string() })).default([]),
  worktreesKept: z.array(z.object({ path: z.string(), reason: z.string(), idleDays: z.number() })),
  nativeBuildsCleared: z.array(z.object({ path: z.string(), bytes: z.number() })).default([]),
  codexThreadsDeleted: z
    .object({ threads: z.number(), bytes: z.number() })
    .default({ threads: 0, bytes: 0 }),
  testDatabasesDropped: z.array(z.object({ name: z.string(), bytes: z.number() })).default([]),
  devicesDeleted: z
    .array(
      z.object({ kind: z.enum(["simulator", "emulator"]), name: z.string(), bytes: z.number() }),
    )
    .default([]),
  /** Steps that took at least a minute, so a run that ran long shows where its time went. */
  slowSteps: z.array(z.object({ step: z.string(), seconds: z.number() })).default([]),
  skipped: z.array(z.string()),
  errors: z.array(z.string()),
});
export type PruneReport = z.infer<typeof reportSchema>;

export function parsePruneReport(value: unknown): PruneReport {
  return reportSchema.parse(value);
}

export function summarizePrune(report: PruneReport): string {
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)}G`;
  const parts = [
    `${report.dryRun ? "would free" : "freed"} ${gib(report.freedBytes)}`,
    `deleted ${report.deleted.length}`,
    `archived ${report.archived.files} files (${gib(report.archived.bytes)})`,
    `low-space sessions archived ${report.lowSpaceArchived.files} (${gib(report.lowSpaceArchived.bytes)})`,
    `browser cache files removed ${report.browserCachesPruned.files} (${gib(report.browserCachesPruned.bytes)})`,
    `temp entries removed ${report.temp.entries} (${gib(report.temp.bytes)})`,
    `worktrees removed ${report.worktreesRemoved.length}`,
    `native builds cleared in ${report.nativeBuildsCleared.length} worktrees`,
    `codex threads deleted ${report.codexThreadsDeleted.threads} (${gib(report.codexThreadsDeleted.bytes)})`,
    `test databases dropped ${report.testDatabasesDropped.length}`,
    `devices deleted ${report.devicesDeleted.length}`,
  ];
  if (report.skipped.length > 0) parts.push(`skipped: ${report.skipped.join("; ")}`);
  if (report.slowSteps.length > 0) {
    parts.push(
      `slow steps: ${report.slowSteps.map((slow) => `${slow.step} ${Math.round(slow.seconds / 60)} min`).join("; ")}`,
    );
  }
  if (report.errors.length > 0) parts.push(`errors: ${report.errors.length}`);
  return parts.join(", ");
}

// =============================================================================
// Filesystem
// =============================================================================

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
) {
  return timedCommand(command, args, {
    timeout: options.timeout ?? 60_000,
    cwd: options.cwd,
  });
}

/**
 * Electron apps such as T3 cache every `.asar` archive their file scans touch and never close it, so an archive inside
 * installed packages pins nothing; work in that checkout still shows as a process cwd or another open file.
 */
const CACHED_ARCHIVE = /\/node_modules\/.+\.asar$/;

export function openPathsFromLsof(output: string): Set<string> {
  return new Set(
    output
      .split("\n")
      .filter((line) => line.startsWith("n/"))
      .map((line) => line.slice(1))
      .filter((path) => !CACHED_ARCHIVE.test(path)),
  );
}

/** Every visible process's open paths, including working directories; undefined when lsof fails. */
export async function listOpenPaths(): Promise<Set<string> | undefined> {
  const result = await run("lsof", ["-nP", "-w", "-Fn"], {
    timeout: 120_000,
  });
  if (!result.stdout) return undefined;
  return openPathsFromLsof(result.stdout);
}

async function sizeBytes(path: string): Promise<number> {
  const result = await run("du", ["-sk", path], { timeout: 180_000 });
  return Number(result.stdout.split("\t")[0] ?? 0) * 1024;
}

/** A folder's age is its newest direct entry, so a run folder that is still being written counts as fresh. */
/**
 * True when the project an Xcode DerivedData folder builds no longer exists. A project on an unmounted volume counts as
 * present, because it comes back when the volume does.
 */
async function xcodeProjectGone(dir: string): Promise<boolean> {
  const path = xcodeWorkspacePath(await readFile(join(dir, "info.plist"), "utf8").catch(() => ""));
  if (!path || existsSync(path)) return false;

  const volume = path.match(/^\/Volumes\/[^/]+/)?.[0];
  return !volume || existsSync(volume);
}

async function childrenWithAge(dir: string): Promise<AgedEntry[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      let mtimeMs = (await lstat(path)).mtimeMs;
      if (entry.isDirectory()) {
        for (const child of await readdir(path)) {
          mtimeMs = Math.max(mtimeMs, (await lstat(join(path, child))).mtimeMs);
        }
      }
      return { path, mtimeMs };
    }),
  );
}

/** Total size of many paths, measured in batches so thousands of small entries cost a few `du` runs. */
async function totalSizeBytes(paths: string[]): Promise<number> {
  let total = 0;
  for (let start = 0; start < paths.length; start += 500) {
    const result = await run("du", ["-sck", ...paths.slice(start, start + 500)], {
      timeout: 180_000,
    });
    total += Number(result.stdout.trim().split("\n").at(-1)?.split("\t")[0] ?? 0) * 1024;
  }
  return total;
}

/** The per-user temp folder; launchd does not set TMPDIR for the watcher. */
async function userTempDir(): Promise<string | undefined> {
  const result = await run("getconf", ["DARWIN_USER_TEMP_DIR"]);
  const dir = result.stdout.trim();
  return result.exitCode === 0 && dir ? dir : undefined;
}

/** Children macOS protects from deletion, such as its services' sandbox folders in the per-user temp folder. */
async function protectedChildren(dir: string): Promise<Set<string>> {
  const flagged = ["(", "-flags", "+sunlnk", "-o", "-flags", "+restricted", ")"];
  const result = await run("find", [
    dir,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    ...flagged,
    "-print0",
  ]);
  if (result.exitCode !== 0) throw new Error(`cannot list protected entries in ${dir}`);
  return new Set(result.stdout.split("\0").filter(Boolean));
}

/** Read one entry at a time, since the per-user temp folder can hold tens of thousands of them. */
async function tempEntries(dir: string, uid: number): Promise<TempEntry[]> {
  const entries: TempEntry[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    try {
      const stat = await lstat(path);
      let mtimeMs = stat.mtimeMs;
      let holdsSocket = false;
      if (stat.isDirectory() && stat.uid === uid) {
        for (const child of await readdir(path, { withFileTypes: true })) {
          holdsSocket ||= child.isSocket();
          mtimeMs = Math.max(mtimeMs, (await lstat(join(path, child.name))).mtimeMs);
        }
      }
      const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      entries.push({ path, name, kind, mtimeMs, ownedByUser: stat.uid === uid, holdsSocket });
    } catch {
      // An entry that vanished or cannot be read is left alone.
    }
  }
  return entries;
}

async function filesWithAge(dir: string): Promise<Array<AgedEntry & { size: number }>> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries.filter((entry) => entry.isFile());
  return Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      const stat = await lstat(path);
      return { path, mtimeMs: stat.mtimeMs, size: stat.size };
    }),
  );
}

/**
 * Moves across volumes by copying first, so an interrupted move never loses the only copy. The copy runs as `cp` with a
 * time limit, because a copy to a stalled external disk can wait for hours and an in-process copy cannot be stopped.
 */
async function moveFile(source: string, target: string): Promise<void> {
  const before = await lstat(source);
  await mkdir(dirname(target), { recursive: true });
  const copied = await run("cp", ["-p", source, target], { timeout: ARCHIVE_COPY_TIMEOUT_MS });
  if (copied.exitCode !== 0) {
    await rm(target, { force: true });
    throw new Error(
      `cannot copy ${source}${copied.timedOut ? " within the time limit" : `: ${copied.stderr.trim()}`}`,
    );
  }
  const verified = await run("cmp", ["-s", source, target], { timeout: ARCHIVE_COPY_TIMEOUT_MS });
  const after = await lstat(source);
  if (
    verified.exitCode !== 0 ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`copy verification failed or source changed for ${source}`);
  }
  await unlink(source);
}

/** Removes the folders a move emptied, deepest first, stopping at the archived root. */
async function removeEmptyParents(files: string[], root: string): Promise<void> {
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = dirname(file); dir.startsWith(`${root}${sep}`); dir = dirname(dir))
      dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  }
}

function archiveMounted(home: string): boolean {
  const volume = statSync(MAC_WATCHER.storage.archiveVolume, { throwIfNoEntry: false });
  return Boolean(volume?.isDirectory() && volume.dev !== statSync(home).dev);
}

interface ArchiveRule {
  path: string;
  days: number;
  to: string;
}

export interface FileStorageRules {
  archiveVolume: string;
  archiveRoot: string;
  archiveFiles: readonly ArchiveRule[];
  lowSpace: {
    freeGiB: number;
    archiveFiles: readonly ArchiveRule[];
    browserCaches: { days: number; paths: readonly string[] };
  };
}

/** Archive files at the normal age, or sooner under disk pressure; delete only old files inside named cache folders. */
export async function pruneFileStorage(options: {
  home: string;
  now: number;
  dryRun: boolean;
  freeBytes: number | undefined;
  openPaths: Set<string>;
  archiveMounted: boolean;
  rules?: FileStorageRules;
}): Promise<
  Pick<
    PruneReport,
    "archived" | "lowSpaceArchived" | "browserCachesPruned" | "freedBytes" | "skipped" | "errors"
  >
> {
  const { home, now, dryRun, openPaths } = options;
  const rules: FileStorageRules = options.rules ?? MAC_WATCHER.storage;
  const lowSpace =
    options.freeBytes !== undefined && options.freeBytes < rules.lowSpace.freeGiB * 1024 ** 3;
  const report = {
    archived: { files: 0, bytes: 0 },
    lowSpaceArchived: { files: 0, bytes: 0 },
    browserCachesPruned: { files: 0, bytes: 0 },
    freedBytes: 0,
    skipped: [] as string[],
    errors: [] as string[],
  };
  const attempt = async (path: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      report.errors.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      );
    }
  };

  if (options.freeBytes === undefined)
    report.skipped.push("Internal free space unavailable; low-space rules skipped");
  if (!options.archiveMounted) {
    report.skipped.push(`${rules.archiveVolume} is not mounted, so nothing was archived`);
  } else {
    const accelerated = lowSpace ? rules.lowSpace.archiveFiles : [];
    const archiveRules = [
      ...accelerated,
      ...rules.archiveFiles.filter(
        (rule) => !accelerated.some((early) => early.path === rule.path),
      ),
    ];
    for (const rule of archiveRules) {
      await attempt(rule.path, async () => {
        const source = join(home, rule.path);
        const files = olderThan(await filesWithAge(source), rule.days, now).filter(
          (file) => !isInUse(file.path, openPaths),
        );
        for (const file of files) {
          await attempt(file.path, async () => {
            if (!dryRun)
              await moveFile(
                file.path,
                join(rules.archiveRoot, rule.to, relative(source, file.path)),
              );
            report.archived.files += 1;
            report.archived.bytes += file.size;
            report.freedBytes += file.size;
            if (accelerated.includes(rule)) {
              report.lowSpaceArchived.files += 1;
              report.lowSpaceArchived.bytes += file.size;
            }
          });
        }
        if (!dryRun)
          await removeEmptyParents(
            files.map((file) => file.path),
            source,
          );
      });
    }
  }

  if (lowSpace) {
    const cacheDirs = new Set<string>();
    for (const pattern of rules.lowSpace.browserCaches.paths) {
      await attempt(pattern, async () => {
        for await (const path of new Bun.Glob(pattern).scan({
          cwd: home,
          absolute: true,
          onlyFiles: false,
          followSymlinks: false,
        })) {
          if ((await lstat(path)).isDirectory()) cacheDirs.add(path);
        }
      });
    }
    for (const dir of cacheDirs) {
      await attempt(dir, async () => {
        const files = olderThan(await filesWithAge(dir), rules.lowSpace.browserCaches.days, now);
        for (const file of files) {
          if (isInUse(file.path, openPaths)) continue;
          await attempt(file.path, async () => {
            if (!dryRun) await unlink(file.path);
            report.browserCachesPruned.files += 1;
            report.browserCachesPruned.bytes += file.size;
            report.freedBytes += file.size;
          });
        }
      });
    }
  }
  return report;
}

// =============================================================================
// Test databases
// =============================================================================

type MysqlQuery = (sql: string) => Promise<string[][] | undefined>;

/** Runs SQL against the local server and returns its rows, or undefined when the client is missing or the query fails. */
function mysqlClient(home: string): MysqlQuery | undefined {
  const herd = join(home, "Library/Application Support/Herd/bin/mysql");
  const binary = Bun.which("mysql") ?? (existsSync(herd) ? herd : undefined);
  if (!binary) return undefined;

  return async (sql) => {
    const result = await run(binary, [
      ...MAC_WATCHER.storage.testDatabases.mysqlArgs,
      "-N",
      "-B",
      "-e",
      sql,
    ]);
    if (result.exitCode !== 0) return undefined;
    return result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split("\t"));
  };
}

/** File mtimes survive MySQL restarts, unlike InnoDB UPDATE_TIME. Unknown ages count as fresh. */
async function newestChangeMs(dir: string): Promise<number> {
  try {
    const names = await readdir(dir);
    const times = await Promise.all(
      names.map(async (name) => (await lstat(join(dir, name))).mtimeMs),
    );
    return Math.max(statSync(dir).mtimeMs, ...times);
  } catch {
    // Unknown age counts as fresh, so the age rule never drops it.
    return Date.now();
  }
}

// =============================================================================
// Simulators and emulators
// =============================================================================

const simulatorListSchema = z.object({
  devices: z.record(
    z.string(),
    z.array(
      z.object({ udid: z.string(), name: z.string(), state: z.string(), dataPath: z.string() }),
    ),
  ),
});

/** A simulator's last use is when it last changed state or wrote data. */
async function simulatorFacts(): Promise<DeviceFacts[]> {
  const result = await run("xcrun", ["simctl", "list", "devices", "-j"]);
  if (result.exitCode !== 0)
    throw new Error(`simctl list failed: ${result.stderr.trim().slice(0, 200)}`);
  const devices = Object.values(
    simulatorListSchema.parse(JSON.parse(result.stdout)).devices,
  ).flat();

  return Promise.all(
    devices.map(async (device) => {
      const path = dirname(device.dataPath);
      const times = await Promise.all(
        [join(path, "device.plist"), device.dataPath].map(
          async (file) => (await lstat(file).catch(() => undefined))?.mtimeMs ?? Date.now(),
        ),
      );
      return {
        kind: "simulator",
        id: device.udid,
        name: device.name,
        running: device.state !== "Shutdown",
        path,
        mtimeMs: Math.max(...times),
      };
    }),
  );
}

/** An emulator's last use is its newest file; one whose folder is on an unmounted drive is skipped. */
async function emulatorFacts(home: string): Promise<DeviceFacts[]> {
  const avdRoot = join(home, ".android/avd");
  if (!existsSync(avdRoot)) return [];
  const commands = (await run("ps", ["-axo", "command="])).stdout;
  const facts: DeviceFacts[] = [];
  for (const file of (await readdir(avdRoot)).filter((name) => name.endsWith(".ini"))) {
    const name = file.slice(0, -".ini".length);
    const path = (await Bun.file(join(avdRoot, file)).text()).match(/^path=(.+)$/m)?.[1]?.trim();
    if (!path || !existsSync(path)) continue;
    // Lock files outlive a crashed emulator, so only a live process counts as running.
    const running = new RegExp(
      `(-avd\\s+|@)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`,
      "m",
    ).test(commands);
    facts.push({
      kind: "emulator",
      id: name,
      name,
      running,
      path,
      mtimeMs: await newestChangeMs(path),
    });
  }
  return facts;
}

// =============================================================================
// Codex
// =============================================================================

/** Pages returned to the disk per step, 100 MB at Codex's page size, so the write-ahead log never grows past one step. */
const VACUUM_PAGES = 25_600;

/** Codex's current file for a database, such as `state_5.sqlite`; Codex raises the number when it migrates one. */
function codexDatabase(home: string, name: string): string | undefined {
  const dir = join(home, ".codex");
  if (!existsSync(dir)) return undefined;
  const versions = readdirSync(dir)
    .map((file) => Number(file.match(new RegExp(`^${name}_(\\d+)\\.sqlite$`))?.[1]))
    .filter((version) => Number.isInteger(version));
  return versions.length > 0 ? join(dir, `${name}_${Math.max(...versions)}.sqlite`) : undefined;
}

/** Runs SQL against a Codex database, waiting while Codex holds a lock, and returns its rows. */
async function sqlite(database: string, sql: string): Promise<string[][]> {
  const result = await run(
    "sqlite3",
    ["-bail", "-cmd", ".timeout 10000", "-separator", "\t", database, sql],
    {
      timeout: 300_000,
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `sqlite3 failed on ${basename(database)}: ${result.stderr.trim().slice(0, 200)}`,
    );
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

async function codexThreadFacts(state: string): Promise<CodexThreadFacts[]> {
  const rows = await sqlite(state, "select id, updated_at, rollout_path from threads");
  return rows.map(([id = "", updatedAt, sessionFile = ""]) => ({
    id,
    updatedMs: Number(updatedAt) * 1000,
    sessionFileExists: existsSync(sessionFile),
  }));
}

/** The given Codex threads that still exist; an id that is unsafe to query counts as existing. */
async function codexThreadsLeft(state: string, ids: string[]): Promise<string[]> {
  const safe = ids.filter((id) => /^[\w-]+$/.test(id));
  const rows =
    safe.length > 0
      ? await sqlite(state, `select id from threads where id in ('${safe.join("', '")}')`)
      : [];
  return [...rows.map(([id = ""]) => id), ...ids.filter((id) => !safe.includes(id))];
}

/** Returns the space deleted threads left inside Codex's history database to the disk; resolves to the bytes saved. */
async function shrinkCodexHistory(history: string): Promise<number> {
  const size = () =>
    [history, `${history}-wal`].reduce(
      (total, file) => total + (statSync(file, { throwIfNoEntry: false })?.size ?? 0),
      0,
    );
  const before = size();

  const [[free = "0"] = []] = await sqlite(history, "pragma freelist_count");
  for (let left = Number(free); left > 0; left -= VACUUM_PAGES) {
    await sqlite(
      history,
      `pragma incremental_vacuum(${VACUUM_PAGES}); pragma wal_checkpoint(truncate)`,
    );
  }

  return Math.max(0, before - size());
}

async function testDatabaseFacts(mysql: MysqlQuery): Promise<TestDatabaseFacts[] | undefined> {
  const rules = MAC_WATCHER.storage.testDatabases;
  const schemas = await mysql("select schema_name from information_schema.schemata");
  if (!schemas) return undefined;

  // Only plain names, since they are interpolated into the queries below.
  const names = schemas
    .map(([name]) => name ?? "")
    .filter((name) => /^\w+$/.test(name) && rules.match.test(name));
  if (names.length === 0) return [];

  const connections = await mysql(
    "select distinct db from information_schema.processlist where db is not null",
  );
  if (!connections) return undefined;
  const inUse = new Set(connections.map(([name]) => name));

  const dataDir = (await mysql("select @@datadir"))?.[0]?.[0] ?? "";
  const sizes = new Map(
    (
      (await mysql(
        "select table_schema, sum(data_length + index_length) from information_schema.tables group by table_schema",
      )) ?? []
    ).map(([schema, bytes]) => [schema ?? "", Number(bytes ?? 0)]),
  );
  const marked = (
    (await mysql(
      `select table_schema from information_schema.tables where table_name = '${rules.markerTable}'`,
    )) ?? []
  )
    .map(([schema]) => schema ?? "")
    .filter((schema) => names.includes(schema));
  const checkouts = new Map<string, string[]>();
  if (marked.length > 0) {
    const rows = await mysql(
      marked
        .map((schema) => `(select '${schema}', path from \`${schema}\`.${rules.markerTable})`)
        .join(" union all "),
    );
    for (const [schema, path] of rows ?? []) {
      if (schema && path) checkouts.set(schema, [...(checkouts.get(schema) ?? []), path]);
    }
  }

  return Promise.all(
    names.map(async (name) => ({
      name,
      checkouts: checkouts.get(name) ?? [],
      touchedMs: dataDir ? await newestChangeMs(join(dataDir, name)) : Date.now(),
      bytes: sizes.get(name) ?? 0,
      inUse: inUse.has(name),
    })),
  );
}

/** Protects suites between connections, including parallel workers and a runner still starting up. */
export function testRunInProgress(commands: string): boolean {
  return /(?:^|[\s/])(?:pest|phpunit|paratest)(?:[\s.]|$)|(?:^|[\s/])artisan\s+test(?:\s|$)|(?:^|[\s/])(?:backend-test|test-runtime)\.ts(?:\s|$)/m.test(
    commands,
  );
}

/** Unknown runner locations or unmarked families stay protected while any suite is running. */
export function testDatabaseRunInProgress(
  databases: TestDatabaseFacts[],
  runnerPaths: Set<string> | undefined,
): boolean {
  if (!runnerPaths) return true;
  if (runnerPaths.size === 0) return false;
  const checkouts = databases.flatMap((database) => database.checkouts);
  if (checkouts.length === 0) return true;

  return checkouts.some((checkout) => {
    const path = existsSync(checkout) ? realpathSync(checkout) : checkout;
    return (
      isInUse(path, runnerPaths) ||
      [...runnerPaths].some((runner) => isInUse(runner, new Set([path])))
    );
  });
}

/** The database-only prune is also used for an explicitly scoped manual cleanup. All drops go through SQL. */
export async function pruneTestDatabases(options: {
  home: string;
  now: Date;
  dryRun: boolean;
}): Promise<Pick<PruneReport, "testDatabasesDropped" | "freedBytes" | "skipped" | "errors">> {
  const report = {
    testDatabasesDropped: [] as { name: string; bytes: number }[],
    freedBytes: 0,
    skipped: [] as string[],
    errors: [] as string[],
  };
  const mysql = mysqlClient(options.home);
  const databases = mysql && (await testDatabaseFacts(mysql));
  if (!mysql || !databases) {
    report.skipped.push("MySQL activity could not be checked, so no test database was touched");
    return report;
  }

  const doomed = testDatabasesToDrop(databases, {
    now: options.now.getTime(),
    idleDays: MAC_WATCHER.storage.testDatabases.idleDays,
    prefixes: ACTIVE_PROJECTS.map((project) => `${project.name.toLowerCase()}_`),
    checkoutExists: existsSync,
  });
  let runnerSignature: string | undefined;
  let runnerPaths: Set<string> | undefined;
  for (const database of doomed) {
    // Recheck immediately before each drop: a suite may start after the initial inventory.
    const processes = await run("ps", ["-axo", "pid=,command="]);
    if (processes.exitCode !== 0) {
      report.skipped.push("Process visibility unavailable; remaining test databases kept");
      break;
    }
    const runners = processes.stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      return match && testRunInProgress(match[2]!) ? [match[1]!] : [];
    });
    const signature = runners.join(",");
    if (signature !== runnerSignature) {
      runnerSignature = signature;
      runnerPaths = new Set();
      if (runners.length) {
        const cwd = await run("lsof", ["-a", "-p", signature, "-d", "cwd", "-Fn"]);
        const seen = new Set<string>();
        let pid: string | undefined;
        for (const line of cwd.stdout.split("\n")) {
          if (line.startsWith("p")) pid = line.slice(1);
          if (line.startsWith("n") && pid) {
            seen.add(pid);
            const path = line.slice(1);
            runnerPaths.add(existsSync(path) ? realpathSync(path) : path);
          }
        }
        if (cwd.exitCode !== 0 || runners.some((pid) => !seen.has(pid))) runnerPaths = undefined;
      }
    }
    if (!runnerPaths) {
      report.skipped.push("Test runner locations unavailable; remaining test databases kept");
      break;
    }
    const family = databases.filter(
      (member) =>
        testDatabaseFamily(member.name) === testDatabaseFamily(database.name) &&
        !report.testDatabasesDropped.some((dropped) => dropped.name === member.name),
    );
    if (testDatabaseRunInProgress(family, runnerPaths)) continue;
    const connections = await mysql(
      "select distinct db from information_schema.processlist where db is not null",
    );
    if (!connections) {
      report.skipped.push("MySQL activity unavailable; remaining test databases kept");
      break;
    }
    if (connections.some(([name]) => family.some((member) => member.name === name))) continue;

    const dataDir = (await mysql("select @@datadir"))?.[0]?.[0];
    const refreshed = await Promise.all(
      family.map(async (member) => ({
        ...member,
        touchedMs: dataDir ? await newestChangeMs(join(dataDir, member.name)) : Date.now(),
      })),
    );
    if (
      !testDatabasesToDrop(refreshed, {
        now: options.now.getTime(),
        idleDays: MAC_WATCHER.storage.testDatabases.idleDays,
        prefixes: ACTIVE_PROJECTS.map((project) => `${project.name.toLowerCase()}_`),
        checkoutExists: existsSync,
      }).some((member) => member.name === database.name)
    )
      continue;

    if (!options.dryRun && !(await mysql(`drop database if exists \`${database.name}\``))) {
      report.errors.push(`test database ${database.name}: drop failed`);
      continue;
    }
    report.testDatabasesDropped.push({ name: database.name, bytes: database.bytes });
    report.freedBytes += database.bytes;
  }
  return report;
}

// =============================================================================
// Worktrees
// =============================================================================

interface ListedWorktree {
  path: string;
  head: string;
  branch: string | undefined;
  locked: boolean;
}

export function parseWorktreeList(porcelain: string): ListedWorktree[] {
  return porcelain
    .split("\n\n")
    .map((block) => block.split("\n"))
    .map((lines) => {
      const value = (key: string) =>
        lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
      return {
        path: value("worktree") ?? "",
        head: value("HEAD") ?? "",
        branch: value("branch")?.replace(/^refs\/heads\//, ""),
        locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
      };
    })
    .filter((worktree) => worktree.path);
}

async function worktreeFacts(
  root: string,
  baseBranch: string,
  worktree: ListedWorktree,
  openPaths: Set<string>,
  now: number,
  abandonedIdleDays: number,
): Promise<WorktreeFacts> {
  const git = (...args: string[]) =>
    run("git", ["--no-optional-locks", "-C", worktree.path, ...args]);
  const [status, gitDir, merged, pr, commit, recentFiles] = await Promise.all([
    git("status", "--porcelain"),
    git("rev-parse", "--absolute-git-dir"),
    git("merge-base", "--is-ancestor", "HEAD", `origin/${baseBranch}`),
    worktree.branch
      ? run(
          "gh",
          [
            "pr",
            "list",
            "--head",
            worktree.branch,
            "--state",
            "all",
            "--json",
            "state,headRefOid,mergedAt,closedAt",
            "--limit",
            "1",
          ],
          {
            cwd: root,
          },
        )
      : Promise.resolve(undefined),
    git("show", "-s", "--format=%ct", "HEAD"),
    cleanupFilesChangedRecently(worktree.path, now),
  ]);

  const activityFiles = ["index", "HEAD", "logs/HEAD"].map((name) =>
    join(gitDir.stdout.trim(), name),
  );
  const lastActivityMs = Math.max(
    ...activityFiles.map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0),
  );
  if (gitDir.exitCode !== 0 || lastActivityMs === 0)
    throw new Error(`cannot read git state for ${worktree.path}`);
  if (pr && pr.exitCode !== 0) throw new Error(`gh pr list failed for ${worktree.branch}`);
  const finishedPr = pr ? JSON.parse(pr.stdout || "[]")[0] : undefined;
  const lastCommitMs = Number(commit.stdout.trim()) * 1000;
  if (commit.exitCode !== 0 || !Number.isFinite(lastCommitMs))
    throw new Error("cannot prove worktree commit age");

  return {
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    locked: worktree.locked,
    dirty: status.exitCode !== 0 || status.stdout.trim() !== "",
    inUse: isInUse(worktree.path, openPaths),
    lastActivityMs: Math.max(lastActivityMs, lastCommitMs),
    mergedIntoBase: merged.exitCode === 0,
    pr: finishedPr,
    prFinishedAt: finishedPr?.mergedAt ?? finishedPr?.closedAt ?? null,
    lastCommitMs,
    recentFiles,
    filesChangedWithinIdleWindow: await cleanupFilesChangedRecently(
      worktree.path,
      now,
      undefined,
      abandonedIdleDays * DAY_MS,
    ),
    filesChangedWithinDay:
      !worktree.branch || merged.exitCode === 0
        ? await cleanupFilesChangedRecently(worktree.path, now, undefined, DAY_MS)
      : undefined,
  };
}

async function archiveFileDigest(path: string): Promise<string> {
  const info = await lstat(path);
  const hash = createHash("sha256").update(String(info.mode));
  if (info.isSymbolicLink()) return hash.update(await readlink(path)).digest("hex");
  if (!info.isFile()) throw new Error(`cannot archive special file ${path}`);
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/** Full HEAD bundle includes every unpublished commit and needs no surviving local or remote prerequisite. */
export async function archiveWorktree(options: {
  path: string;
  repo: string;
  archiveRoot: string;
  now: Date;
  mounted: () => boolean;
}): Promise<{ archive: string; unchanged: () => Promise<boolean> }> {
  const { path, repo, archiveRoot, now, mounted } = options;
  if (!mounted()) throw new Error("archive SSD is not mounted; worktree kept");
  const git = async (...args: string[]) => {
    const result = await run("git", ["--no-optional-locks", "-C", path, ...args], {
      timeout: ARCHIVE_COPY_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      throw new Error(`archive git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  // A superproject patch cannot preserve unpublished commits or dirty files inside nested repositories.
  if ((await git("ls-files", "--stage")).split("\n").some((line) => line.startsWith("160000 ")))
    throw new Error("submodule work requires a separate archive; worktree kept");
  const snapshot = async () => {
    const head = (await git("rev-parse", "HEAD")).trim();
    const status = await git("status", "--porcelain=v1", "-z", "--untracked-files=all");
    const untracked = (await git("ls-files", "--others", "--exclude-standard", "-z"))
      .split("\0")
      .filter(Boolean);
    const hashes: Record<string, string> = Object.create(null);
    for (const file of untracked) hashes[file] = await archiveFileDigest(join(path, file));
    return { head, status, hashes };
  };
  const before = await snapshot();
  const parent = join(archiveRoot, "worktrees", repo);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const archive = await mkdtemp(
    join(parent, `${basename(path)}-${now.toISOString().replaceAll(":", "-")}-`),
  );
  const patch = join(archive, "changes.patch");
  const staged = join(archive, "staged.patch");
  await git(
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    `--output=${patch}`,
    "HEAD",
    "--",
  );
  await git(
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    `--output=${staged}`,
    "HEAD",
    "--",
  );
  const patchHash = await archiveFileDigest(patch);
  const stagedHash = await archiveFileDigest(staged);
  for (const [file, hash] of Object.entries(before.hashes)) {
    const target = join(archive, "untracked", file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const copied = await run("cp", ["-pPR", join(path, file), target], {
      timeout: ARCHIVE_COPY_TIMEOUT_MS,
    });
    if (copied.exitCode !== 0) throw new Error(`cannot copy untracked file ${file} to archive`);
    if ((await archiveFileDigest(target)) !== hash)
      throw new Error(`untracked archive verification failed: ${file}`);
  }
  const bundle = join(archive, "commits.bundle");
  await git("bundle", "create", bundle, "HEAD");
  const bundleHash = await archiveFileDigest(bundle);
  const scratch = await mkdtemp(join(tmpdir(), "worktree-archive-verify-"));
  try {
    const verification = join(scratch, "repo.git");
    const checked = async (...args: string[]) => {
      const result = await run("git", args, { timeout: ARCHIVE_COPY_TIMEOUT_MS });
      if (result.exitCode !== 0)
        throw new Error(`archive verification failed: ${result.stderr.trim()}`);
      return result.stdout.trim();
    };
    await checked("clone", "--bare", bundle, verification);
    await checked("-C", verification, "fsck", "--full");
    if ((await checked("-C", verification, "rev-parse", "HEAD")) !== before.head)
      throw new Error("archive bundle HEAD mismatch");
    await checked("-C", verification, "read-tree", "HEAD");
    if ((await lstat(patch)).size)
      await checked("-C", verification, "apply", "--cached", "--check", patch);
    if ((await lstat(staged)).size)
      await checked("-C", verification, "apply", "--cached", "--check", staged);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const unchanged = async () => {
    if (!mounted() || JSON.stringify(await snapshot()) !== JSON.stringify(before)) return false;
    if (
      (await archiveFileDigest(bundle)) !== bundleHash ||
      (await archiveFileDigest(patch)) !== patchHash ||
      (await archiveFileDigest(staged)) !== stagedHash
    )
      return false;
    for (const [file, hash] of Object.entries(before.hashes))
      if ((await archiveFileDigest(join(archive, "untracked", file))) !== hash) return false;
    const scratch = await mkdtemp(join(tmpdir(), "worktree-archive-diff-"));
    try {
      const current = join(scratch, "changes.patch");
      const index = join(scratch, "staged.patch");
      await git(
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        `--output=${current}`,
        "HEAD",
        "--",
      );
      await git(
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        `--output=${index}`,
        "HEAD",
        "--",
      );
      return (
        (await archiveFileDigest(current)) === patchHash &&
        (await archiveFileDigest(index)) === stagedHash
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  if (!(await unchanged())) throw new Error("worktree changed during archive; worktree kept");
  await writeFile(
    join(archive, "manifest.json"),
    JSON.stringify(
      {
        source: path,
        at: now.toISOString(),
        ...before,
        patchHash,
        stagedHash,
        bundleHash,
        unpublishedCommits: (await git("rev-list", "HEAD", "--not", "--remotes"))
          .trim()
          .split("\n")
          .filter(Boolean),
        verified: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { archive, unchanged };
}

/** Reinstallable ignored folders; any change anywhere in the checkout protects all of them. */
export async function idleNativeBuilds(worktree: string, now: number): Promise<string[]> {
  const rule = MAC_WATCHER.storage.nativeBuilds;
  if (await cleanupFilesChangedRecently(worktree, now, undefined, rule.idleHours * HOUR_MS))
    return [];

  const listed = await run("git", [
    "-C",
    worktree,
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (listed.exitCode !== 0) throw new Error(`cannot list ignored files in ${worktree}`);
  const tracked = await run("git", ["-C", worktree, "ls-files", "-z", "--cached"]);
  if (tracked.exitCode !== 0) throw new Error(`cannot list tracked files in ${worktree}`);
  const { outputs, dependencyDirs } = nativeBuildCandidates(
    listed.stdout.split("\0").filter(Boolean),
    rule,
    tracked.stdout.split("\0").filter(Boolean),
  );
  const paths = [...new Set([...outputs, ...dependencyDirs])];

  return paths
    .filter((path) => !paths.some((parent) => parent !== path && path.startsWith(parent)))
    .map((path) => join(worktree, path).replace(/\/$/, ""));
}

/**
 * A device lease's agent and a heavy run's command keep their checkout open as a working directory, so the open-path
 * check protects exactly the checkout they use. Fail closed only when a lease holder is unknown or a legacy host run
 * is active, since neither names a checkout. Merge candidates live in the queue's own clone, never in these checkouts.
 */
export function dependencyPruneLeasesIdle(queue = readQueueState()): boolean {
  return (
    Object.values(queue.leases).every((lease) => lease.agentPid > 0) && queue.host.active === null
  );
}

// =============================================================================
// Run
// =============================================================================

/** `onStep` hears each step as it starts, so whoever stops a stuck run can name the step it was stuck in. */
export async function pruneStorage(options: {
  home: string;
  now: Date;
  dryRun: boolean;
  onStep?: (step: string) => void;
}): Promise<PruneReport> {
  const { home, dryRun, onStep } = options;
  const now = options.now.getTime();
  const rules = MAC_WATCHER.storage;
  const report: PruneReport = {
    at: options.now.toISOString(),
    dryRun,
    freedBytes: 0,
    deleted: [],
    archived: { files: 0, bytes: 0 },
    lowSpaceArchived: { files: 0, bytes: 0 },
    browserCachesPruned: { files: 0, bytes: 0 },
    temp: { entries: 0, bytes: 0 },
    worktreesRemoved: [],
    worktreesArchived: [],
    worktreesKept: [],
    nativeBuildsCleared: [],
    codexThreadsDeleted: { threads: 0, bytes: 0 },
    testDatabasesDropped: [],
    devicesDeleted: [],
    slowSteps: [],
    skipped: [],
    errors: [],
  };
  const attempt = async (label: string, step: () => Promise<void>) => {
    onStep?.(label);
    const started = Date.now();
    try {
      await step();
    } catch (error) {
      report.errors.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      );
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    if (seconds >= SLOW_STEP_SECONDS) report.slowSteps.push({ step: label, seconds });
  };

  onStep?.("open files");
  const openPaths = await listOpenPaths();
  if (!openPaths) {
    report.skipped.push("lsof failed, so nothing was touched");
    return report;
  }

  const clearIdleBuilds = async (checkout: string) => {
    if (!dependencyPruneLeasesIdle() || isInUse(checkout, openPaths)) return;
    const builds = await idleNativeBuilds(checkout, now);
    if (builds.length === 0) return;
    if (!dryRun) {
      const freshOpen = await listOpenPaths();
      if (!freshOpen || isInUse(checkout, freshOpen) || !dependencyPruneLeasesIdle()) return;
      if (
        await cleanupFilesChangedRecently(
          checkout,
          Date.now(),
          undefined,
          rules.nativeBuilds.idleHours * HOUR_MS,
        )
      )
        return;
    }
    const bytes = await totalSizeBytes(builds);
    if (!dryRun) for (const path of builds) await rm(path, { recursive: true, force: true });
    report.nativeBuildsCleared.push({ path: checkout, bytes });
    report.freedBytes += bytes;
  };

  let freeBytes: number | undefined;
  await attempt("internal free space", async () => {
    const disk = await statfs(home);
    freeBytes = disk.bavail * disk.bsize;
  });

  let cleanupThreads: CleanupThread[] | null = null;
  let worktreeVisibility = false;
  const protectedWorktreePaths = new Set(openPaths);
  await attempt("worktree bindings", async () => {
    cleanupThreads = await readCleanupThreads(home);
    const protect = (path: string) => {
      protectedWorktreePaths.add(existsSync(path) ? realpathSync(path) : path);
    };
    for (const thread of cleanupThreads) {
      protect(thread.projectRoot);
      if (thread.worktreePath) protect(thread.worktreePath);
    }
    for (const project of STORAGE_WORKTREE_PROJECTS) {
      if (!existsSync(project.canonicalRoot)) continue;
      const result = await run("git", [
        "-C",
        project.canonicalRoot,
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (result.exitCode !== 0) throw new Error(`cannot list worktrees for ${project.name}`);
      for (const tree of parseWorktreeList(result.stdout)) protect(tree.path);
    }
    worktreeVisibility = true;
  });

  for (const rule of rules.deleteChildren) {
    await attempt(rule.path, async () => {
      const match = "match" in rule ? rule.match : undefined;
      const projectGoneHours = "projectGoneHours" in rule ? rule.projectGoneHours : undefined;
      const children = await Promise.all(
        (await childrenWithAge(join(home, rule.path)))
          .filter((child) => !match || match.test(child.path))
          .map(async (child) => ({
            ...child,
            projectGone: projectGoneHours !== undefined && (await xcodeProjectGone(child.path)),
          })),
      );

      for (const child of staleChildren(children, { days: rule.days, projectGoneHours, now })) {
        if (isInUse(child.path, openPaths)) continue;
        const bytes = await sizeBytes(child.path);
        if (!dryRun) await rm(child.path, { recursive: true, force: true });
        report.deleted.push({ path: child.path, bytes });
        report.freedBytes += bytes;
      }
    });
  }

  await attempt("temp", async () => {
    if (!worktreeVisibility) {
      report.skipped.push("worktree visibility unavailable; temporary directories kept");
      return;
    }
    const uid = process.getuid?.() ?? -1;
    const dirs = ["/private/tmp", await userTempDir()].filter((dir): dir is string =>
      Boolean(dir && existsSync(dir)),
    );
    for (const dir of dirs.map((dir) => realpathSync(dir))) {
      const kept = new Set([
        ...childrenInUse(dir, protectedWorktreePaths),
        ...(await protectedChildren(dir)),
      ]);
      const leftovers: TempEntry[] = [];
      for (const entry of tempLeftovers(await tempEntries(dir, uid), { ...rules.temp, now })) {
        if (kept.has(entry.path)) continue;
        if (
          rules.temp.toolCaches.match.test(entry.name) &&
          !(await toolCacheIdle(entry.path, now, rules.temp.toolCaches.days))
        )
          continue;
        leftovers.push(entry);
      }
      const bytes = await totalSizeBytes(leftovers.map((entry) => entry.path));
      if (!dryRun) {
        for (const entry of leftovers)
          await attempt(entry.path, () => rm(entry.path, { recursive: true, force: true }));
      }
      report.temp.entries += leftovers.length;
      report.temp.bytes += bytes;
      report.freedBytes += bytes;
    }
  });

  await attempt("archives and browser caches", async () => {
    const result = await pruneFileStorage({
      home,
      now,
      dryRun,
      freeBytes,
      openPaths,
      archiveMounted: archiveMounted(home),
    });
    report.archived = result.archived;
    report.lowSpaceArchived = result.lowSpaceArchived;
    report.browserCachesPruned = result.browserCachesPruned;
    report.freedBytes += result.freedBytes;
    report.skipped.push(...result.skipped);
    report.errors.push(...result.errors);
  });

  const codexState = codexDatabase(home, "state");
  const codexHistory = codexDatabase(home, "thread_history");
  if (codexState && codexHistory) {
    await attempt("codex threads", async () => {
      const idle = codexThreadsToDelete(await codexThreadFacts(codexState), {
        idleDays: rules.codex.threadIdleDays,
        now,
      });
      if (dryRun) {
        report.codexThreadsDeleted.threads = idle.length;
        return;
      }

      // One at a time, since parallel deletes fail on Codex's database locks. Deleting a thread also deletes its
      // subagents' threads, so a later delete that fails because its thread is already gone still counts.
      const failed: string[] = [];
      for (const thread of idle) {
        const deleted = await run("codex", ["delete", "--force", thread.id]);
        if (deleted.exitCode !== 0) failed.push(thread.id);
      }
      const left = failed.length > 0 ? await codexThreadsLeft(codexState, failed) : [];
      report.codexThreadsDeleted.threads += idle.length - left.length;
      if (left.length > 0)
        throw new Error(`codex delete failed for ${left.length} threads, such as ${left[0]}`);
    });

    // Also returns space left by a run that stopped partway.
    if (!dryRun) {
      await attempt("codex history", async () => {
        const bytes = await shrinkCodexHistory(codexHistory);
        report.codexThreadsDeleted.bytes += bytes;
        report.freedBytes += bytes;
      });
    }
  }

  await attempt("codex releases", async () => {
    const standalone = join(home, ".codex/packages/standalone");
    if (!existsSync(join(standalone, "current"))) return;
    const current = basename(realpathSync(join(standalone, "current")));
    const releases = codexReleasesToDelete(
      await childrenWithAge(join(standalone, "releases")),
      current,
      rules.codex.keepReleases,
    );
    for (const release of releases.filter((release) => !isInUse(release.path, openPaths))) {
      const bytes = await sizeBytes(release.path);
      if (!dryRun) await rm(release.path, { recursive: true, force: true });
      report.deleted.push({ path: release.path, bytes });
      report.freedBytes += bytes;
    }
  });

  await attempt("simulators", async () => {
    if (!dryRun && Bun.which("xcrun")) await run("xcrun", ["simctl", "delete", "unavailable"]);
  });

  await attempt("devices", async () => {
    const devices = [
      ...(Bun.which("xcrun") ? await simulatorFacts() : []),
      ...(await emulatorFacts(home)),
    ];
    const unused = devicesToDelete(devices, { ...rules.devices, now }).filter(
      (device) => !isInUse(device.path, openPaths),
    );
    for (const device of unused) {
      await attempt(`${device.kind} ${device.name}`, async () => {
        const bytes = await sizeBytes(device.path);
        if (!dryRun && device.kind === "simulator") {
          const deleted = await run("xcrun", ["simctl", "delete", device.id]);
          if (deleted.exitCode !== 0)
            throw new Error(deleted.stderr.trim() || "simctl delete failed");
        }
        if (!dryRun && device.kind === "emulator") {
          await rm(device.path, { recursive: true, force: true });
          await rm(join(home, ".android/avd", `${device.id}.ini`), { force: true });
        }
        report.devicesDeleted.push({ kind: device.kind, name: device.name, bytes });
        report.freedBytes += bytes;
      });
    }
  });

  for (const project of STORAGE_WORKTREE_PROJECTS) {
    if (!existsSync(project.canonicalRoot)) continue;
    await attempt(project.name, async () => {
      if (!cleanupThreads) {
        report.skipped.push(`${project.name}: T3 thread visibility unavailable; worktrees kept`);
        return;
      }
      const listed = await run("git", [
        "-C",
        project.canonicalRoot,
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (listed.exitCode !== 0) throw new Error("git worktree list failed");
      const agentWorktrees = parseWorktreeList(listed.stdout).filter((worktree) =>
        rules.agentWorktreeDirs.some((dir) => worktree.path.includes(dir)),
      );
      for (const worktree of agentWorktrees) {
        await attempt(worktree.path, async () => {
          if (!existsSync(worktree.path)) return;
          const bound = cleanupBoundThreads(
            project.canonicalRoot,
            worktree.path,
            worktree.branch ?? null,
            cleanupThreads!,
          );
          const running = bound.filter((thread) => thread.running).map((thread) => thread.title);
          // A worktree made in the last four hours may not be bound to its thread yet, so any busy thread in its project
          // keeps it.
          const young = now - statSync(worktree.path).birthtimeMs < WORKTREE_CLEANUP_GRACE_MS;
          const busy = young
            ? cleanupProjectThreadTitles(project.canonicalRoot, cleanupThreads!, now)
            : [];
          if (
            !cleanupWorktreeAllowed(worktree.path, project.canonicalRoot, home) ||
            running.length ||
            busy.length
          ) {
            report.worktreesKept.push({
              path: worktree.path,
              reason: running.length
                ? `running T3 thread: ${running.join(", ")}`
                : busy.length
                  ? `new worktree in a busy T3 project: ${busy.join(", ")}`
                  : "outside managed worktree roots",
              idleDays: 0,
            });
            return;
          }
          const facts: WorktreeFacts = {
            ...(await worktreeFacts(
              project.canonicalRoot,
              project.baseBranch,
              worktree,
              openPaths,
              now,
              bound.length ? rules.worktreeIdleDays.thread : rules.worktreeIdleDays.abandoned,
            )),
            threads: bound.filter((thread) => !thread.running).map((thread) => thread.title),
          };
          const decision = decideWorktree(facts, now, rules.worktreeIdleDays);
          if (!decision.remove) {
            const idleDays = Math.max(0, Math.floor((now - facts.lastActivityMs) / DAY_MS));
            report.worktreesKept.push({ path: worktree.path, reason: decision.reason, idleDays });

            if (
              facts.locked ||
              facts.inUse ||
              now - facts.lastActivityMs < rules.nativeBuilds.idleHours * HOUR_MS
            )
              return;
            await clearIdleBuilds(worktree.path);
            return;
          }
          if (decision.archive && !archiveMounted(home)) {
            report.worktreesKept.push({
              path: worktree.path,
              reason: "archive SSD is not mounted",
              idleDays: Math.floor((now - facts.lastActivityMs) / DAY_MS),
            });
            return;
          }
          const bytes = await sizeBytes(worktree.path);
          if (!dryRun) {
            const archived = decision.archive
              ? await archiveWorktree({
                  path: worktree.path,
                  repo: basename(project.canonicalRoot),
                  archiveRoot: rules.archiveRoot,
                  now: options.now,
                  mounted: () => archiveMounted(home),
                })
              : undefined;
            if (archived)
              report.worktreesArchived.push({ path: worktree.path, archive: archived.archive });

            // Archiving can take minutes. Refresh process, thread, lock, branch, HEAD, and file activity before deletion.
            const freshOpen = await listOpenPaths();
            if (!freshOpen) throw new Error("cannot recheck open paths; worktree kept");
            const freshThreads = await readCleanupThreads(home);
            if (
              cleanupBoundThreads(
                project.canonicalRoot,
                worktree.path,
                worktree.branch ?? null,
                freshThreads,
              ).some((thread) => thread.running)
            )
              throw new Error("T3 thread started during cleanup; worktree kept");
            const refreshed = await run("git", [
              "-C",
              project.canonicalRoot,
              "worktree",
              "list",
              "--porcelain",
            ]);
            if (refreshed.exitCode !== 0) throw new Error("cannot recheck worktree registration");
            const current = parseWorktreeList(refreshed.stdout).find(
              (tree) => tree.path === worktree.path,
            );
            if (!current || current.head !== facts.head || current.branch !== facts.branch)
              throw new Error("worktree identity changed; worktree kept");
            const freshFacts = await worktreeFacts(
              project.canonicalRoot,
              project.baseBranch,
              current,
              freshOpen,
              Date.now(),
              bound.length ? rules.worktreeIdleDays.thread : rules.worktreeIdleDays.abandoned,
            );
            const freshDecision = decideWorktree(
              { ...freshFacts, threads: facts.threads },
              Date.now(),
              rules.worktreeIdleDays,
            );
            if (
              !freshDecision.remove ||
              Boolean(freshDecision.archive) !== Boolean(decision.archive)
            )
              throw new Error(
                `worktree safety changed; worktree kept${!freshDecision.remove ? `: ${freshDecision.reason}` : ""}`,
              );
            if (archived && !(await archived.unchanged()))
              throw new Error("archive or source changed; worktree kept");
            const removed = await run(
              "git",
              [
                "-C",
                project.canonicalRoot,
                "worktree",
                "remove",
                ...(decision.archive ? ["--force"] : []),
                worktree.path,
              ],
              { timeout: ARCHIVE_COPY_TIMEOUT_MS },
            );
            if (removed.exitCode !== 0)
              throw new Error(removed.stderr.trim() || "git worktree remove failed");
            const pruned = await run("git", ["-C", project.canonicalRoot, "worktree", "prune"]);
            if (pruned.exitCode !== 0)
              report.errors.push(`${project.name}: git worktree prune failed`);
          }
          report.worktreesRemoved.push({ path: worktree.path, bytes });
          report.freedBytes += bytes;
        });
      }
    });
  }

  await attempt("temporary checkout dependencies", async () => {
    for (const parent of ["/private/tmp", await userTempDir()].filter((path): path is string =>
      Boolean(path),
    )) {
      if (!existsSync(parent)) continue;
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const checkout = join(parent, entry.name);
        if (!existsSync(join(checkout, ".git"))) continue;
        const root = await run("git", ["-C", checkout, "rev-parse", "--show-toplevel"]);
        if (root.exitCode !== 0 || realpathSync(root.stdout.trim()) !== realpathSync(checkout))
          continue;
        await clearIdleBuilds(checkout);
      }
    }
  });

  await attempt("test databases", async () => {
    const result = await pruneTestDatabases({ home, now: options.now, dryRun });
    report.testDatabasesDropped.push(...result.testDatabasesDropped);
    report.freedBytes += result.freedBytes;
    report.skipped.push(...result.skipped);
    report.errors.push(...result.errors);
  });

  return report;
}
