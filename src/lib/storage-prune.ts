import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { execa } from "execa";
import { z } from "zod";

import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { MAC_WATCHER } from "../../config/mac-watcher";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
  pr: { state: "OPEN" | "MERGED" | "CLOSED"; headRefOid: string } | undefined;
}

export type WorktreeDecision = { remove: true } | { remove: false; reason: string };

/**
 * A worktree goes only when removing it loses nothing: it has no uncommitted or untracked files, nobody is using it, and
 * its commits stay reachable from the base branch, a finished PR, or its own branch, which is kept. A landed worktree goes
 * soon after its work is done; one whose branch never landed waits longer in case its work resumes, and stays while its
 * PR is open. Detached commits that never landed have no branch to keep them, so they always stay.
 */
export function decideWorktree(
  facts: WorktreeFacts,
  now: number,
  idleDays: { landed: number; abandoned: number },
): WorktreeDecision {
  if (facts.locked) return { remove: false, reason: "locked" };
  if (facts.inUse) return { remove: false, reason: "in use by a running process" };
  if (facts.dirty) return { remove: false, reason: "uncommitted changes" };

  // Git activity during the run itself can land after `now`.
  const idle = Math.max(0, now - facts.lastActivityMs) / DAY_MS;
  const active = `active ${Math.floor(idle)}d ago`;
  const prFinished = facts.pr !== undefined && facts.pr.state !== "OPEN" && facts.pr.headRefOid === facts.head;
  if (facts.mergedIntoBase || prFinished) {
    return idle < idleDays.landed ? { remove: false, reason: `landed, ${active}` } : { remove: true };
  }

  if (!facts.branch) return { remove: false, reason: "detached HEAD" };
  if (facts.pr?.state === "OPEN") return { remove: false, reason: "PR open" };
  if (idle < idleDays.abandoned) return { remove: false, reason: active };
  return { remove: true };
}

/** The folders git lists as ignored that hold native build output, and the dependency folders to search for more. */
export function nativeBuildCandidates(
  ignoredPaths: string[],
  rule: { ignored: RegExp; dependencies: { dir: RegExp } },
): { outputs: string[]; dependencyDirs: string[] } {
  return {
    outputs: ignoredPaths.filter((path) => rule.ignored.test(path)),
    dependencyDirs: ignoredPaths.filter((path) => rule.dependencies.dir.test(path)),
  };
}

/** Installed Codex versions to delete: every one but the current version and the newest others up to `keep` in all. */
export function codexReleasesToDelete<T extends AgedEntry>(releases: T[], current: string, keep: number): T[] {
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
  return threads.filter((thread) => !thread.sessionFileExists && options.now - thread.updatedMs > options.idleDays * DAY_MS);
}

export interface TempEntry extends AgedEntry {
  name: string;
  kind: "file" | "directory" | "other";
  ownedByUser: boolean;
  /** A socket sits in the folder itself, so a live service may still listen there. */
  holdsSocket: boolean;
}

/** Temp entries agent runs left behind: this user's plain files and folders that no live service may still need. */
export function tempLeftovers(entries: TempEntry[], options: { days: number; skip: RegExp; now: number }): TempEntry[] {
  return olderThan(entries, options.days, options.now).filter(
    (entry) => entry.kind !== "other" && entry.ownedByUser && !entry.holdsSocket && !options.skip.test(entry.name),
  );
}

/** Direct children of `dir` that a running process holds open or works in, found in one pass over the open paths. */
export function childrenInUse(dir: string, openPaths: Set<string>): Set<string> {
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  const children = new Set<string>();
  for (const open of openPaths) {
    if (open.startsWith(prefix)) children.add(join(dir, open.slice(prefix.length).split(sep)[0] ?? ""));
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
export function devicesToDelete(devices: DeviceFacts[], options: { days: number; keep: RegExp; now: number }): DeviceFacts[] {
  return olderThan(devices, options.days, options.now).filter((device) => !device.running && !options.keep.test(device.name));
}

export interface TestDatabaseFacts {
  name: string;
  /** The checkouts the suite recorded when it built the database; empty when it recorded none. */
  checkouts: string[];
  touchedMs: number;
  bytes: number;
}

/** A parallel worker's copy is named after the database it was made from. */
export function testDatabaseFamily(name: string): string {
  return name.replace(/_test_\d+$/, "");
}

/**
 * Test databases whose checkout is gone, with their workers' copies. A family without a recorded checkout goes only when
 * it belongs to an active project, whose suite rebuilds a missing database, and none of it was touched for `unmarkedDays`.
 */
export function testDatabasesToDrop(
  databases: TestDatabaseFacts[],
  options: { now: number; unmarkedDays: number; prefixes: string[]; checkoutExists: (path: string) => boolean },
): TestDatabaseFacts[] {
  const families = new Map<string, TestDatabaseFacts[]>();
  for (const database of databases) {
    const family = testDatabaseFamily(database.name);
    families.set(family, [...(families.get(family) ?? []), database]);
  }

  return [...families.entries()].flatMap(([family, members]) => {
    // A family stays while any checkout recorded in it still exists.
    const checkouts = members.flatMap((member) => member.checkouts);
    if (checkouts.length > 0) return checkouts.some(options.checkoutExists) ? [] : members;

    const owned = options.prefixes.some((prefix) => family.startsWith(prefix));
    const touched = Math.max(...members.map((member) => member.touchedMs));
    return owned && options.now - touched > options.unmarkedDays * DAY_MS ? members : [];
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
  temp: z.object({ entries: z.number(), bytes: z.number() }).default({ entries: 0, bytes: 0 }),
  worktreesRemoved: z.array(z.object({ path: z.string(), bytes: z.number() })),
  worktreesKept: z.array(z.object({ path: z.string(), reason: z.string(), idleDays: z.number() })),
  nativeBuildsCleared: z.array(z.object({ path: z.string(), bytes: z.number() })).default([]),
  codexThreadsDeleted: z.object({ threads: z.number(), bytes: z.number() }).default({ threads: 0, bytes: 0 }),
  testDatabasesDropped: z.array(z.object({ name: z.string(), bytes: z.number() })).default([]),
  devicesDeleted: z
    .array(z.object({ kind: z.enum(["simulator", "emulator"]), name: z.string(), bytes: z.number() }))
    .default([]),
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
    `temp entries removed ${report.temp.entries} (${gib(report.temp.bytes)})`,
    `worktrees removed ${report.worktreesRemoved.length}`,
    `native builds cleared in ${report.nativeBuildsCleared.length} worktrees`,
    `codex threads deleted ${report.codexThreadsDeleted.threads} (${gib(report.codexThreadsDeleted.bytes)})`,
    `test databases dropped ${report.testDatabasesDropped.length}`,
    `devices deleted ${report.devicesDeleted.length}`,
  ];
  if (report.skipped.length > 0) parts.push(`skipped: ${report.skipped.join("; ")}`);
  if (report.errors.length > 0) parts.push(`errors: ${report.errors.length}`);
  return parts.join(", ");
}

// =============================================================================
// Filesystem
// =============================================================================

async function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return execa(command, args, { reject: false, timeout: options.timeout ?? 60_000, cwd: options.cwd });
}

/** Every path any of this user's processes holds open, including working directories; undefined when lsof fails. */
async function listOpenPaths(): Promise<Set<string> | undefined> {
  const result = await run("lsof", ["-nP", "-w", "-Fn", "-u", String(process.getuid?.() ?? 0)], { timeout: 120_000 });
  if (!result.stdout) return undefined;
  const paths = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1));
  return new Set(paths);
}

async function sizeBytes(path: string): Promise<number> {
  const result = await run("du", ["-sk", path], { timeout: 180_000 });
  return Number(result.stdout.split("\t")[0] ?? 0) * 1024;
}

/** A folder's age is its newest direct entry, so a run folder that is still being written counts as fresh. */
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
    const result = await run("du", ["-sck", ...paths.slice(start, start + 500)], { timeout: 180_000 });
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
  const result = await run("find", [dir, "-mindepth", "1", "-maxdepth", "1", ...flagged, "-print0"]);
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

/** Moves across volumes by copying first, so an interrupted move never loses the only copy. */
async function moveFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  if ((await lstat(target)).size !== (await lstat(source)).size) {
    throw new Error(`copy size mismatch for ${source}`);
  }
  await unlink(source);
}

/** Removes the folders a move emptied, deepest first, stopping at the archived root. */
async function removeEmptyParents(files: string[], root: string): Promise<void> {
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = dirname(file); dir.startsWith(`${root}${sep}`); dir = dirname(dir)) dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  }
}

function archiveMounted(home: string): boolean {
  const volume = statSync(MAC_WATCHER.storage.archiveVolume, { throwIfNoEntry: false });
  return Boolean(volume?.isDirectory() && volume.dev !== statSync(home).dev);
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
    const result = await run(binary, [...MAC_WATCHER.storage.testDatabases.mysqlArgs, "-N", "-B", "-e", sql]);
    if (result.exitCode !== 0) return undefined;
    return result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split("\t"));
  };
}

/** The newest change to any file of a database, from its folder in the server's data directory. */
async function newestChangeMs(dir: string): Promise<number> {
  try {
    const names = await readdir(dir);
    const times = await Promise.all(names.map(async (name) => (await lstat(join(dir, name))).mtimeMs));
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
  devices: z.record(z.string(), z.array(z.object({ udid: z.string(), name: z.string(), state: z.string(), dataPath: z.string() }))),
});

/** A simulator's last use is when it last changed state or wrote data. */
async function simulatorFacts(): Promise<DeviceFacts[]> {
  const result = await run("xcrun", ["simctl", "list", "devices", "-j"]);
  if (result.exitCode !== 0) throw new Error(`simctl list failed: ${result.stderr.trim().slice(0, 200)}`);
  const devices = Object.values(simulatorListSchema.parse(JSON.parse(result.stdout)).devices).flat();

  return Promise.all(
    devices.map(async (device) => {
      const path = dirname(device.dataPath);
      const times = await Promise.all(
        [join(path, "device.plist"), device.dataPath].map(async (file) => (await lstat(file).catch(() => undefined))?.mtimeMs ?? Date.now()),
      );
      return { kind: "simulator", id: device.udid, name: device.name, running: device.state !== "Shutdown", path, mtimeMs: Math.max(...times) };
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
    const running = new RegExp(`(-avd\\s+|@)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m").test(commands);
    facts.push({ kind: "emulator", id: name, name, running, path, mtimeMs: await newestChangeMs(path) });
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
  const result = await run("sqlite3", ["-bail", "-cmd", ".timeout 10000", "-separator", "\t", database, sql], {
    timeout: 300_000,
  });
  if (result.exitCode !== 0) throw new Error(`sqlite3 failed on ${basename(database)}: ${result.stderr.trim().slice(0, 200)}`);
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
  const rows = safe.length > 0 ? await sqlite(state, `select id from threads where id in ('${safe.join("', '")}')`) : [];
  return [...rows.map(([id = ""]) => id), ...ids.filter((id) => !safe.includes(id))];
}

/** Returns the space deleted threads left inside Codex's history database to the disk; resolves to the bytes saved. */
async function shrinkCodexHistory(history: string): Promise<number> {
  const size = () =>
    [history, `${history}-wal`].reduce((total, file) => total + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0);
  const before = size();

  const [[free = "0"] = []] = await sqlite(history, "pragma freelist_count");
  for (let left = Number(free); left > 0; left -= VACUUM_PAGES) {
    await sqlite(history, `pragma incremental_vacuum(${VACUUM_PAGES}); pragma wal_checkpoint(truncate)`);
  }

  return Math.max(0, before - size());
}

async function testDatabaseFacts(mysql: MysqlQuery): Promise<TestDatabaseFacts[] | undefined> {
  const rules = MAC_WATCHER.storage.testDatabases;
  const schemas = await mysql("select schema_name from information_schema.schemata");
  if (!schemas) return undefined;

  // Only plain names, since they are interpolated into the queries below.
  const names = schemas.map(([name]) => name ?? "").filter((name) => /^\w+$/.test(name) && rules.match.test(name));
  if (names.length === 0) return [];

  const dataDir = (await mysql("select @@datadir"))?.[0]?.[0] ?? "";
  const sizes = new Map(
    ((await mysql("select table_schema, sum(data_length + index_length) from information_schema.tables group by table_schema")) ?? []).map(
      ([schema, bytes]) => [schema ?? "", Number(bytes ?? 0)],
    ),
  );
  const marked = (
    (await mysql(`select table_schema from information_schema.tables where table_name = '${rules.markerTable}'`)) ?? []
  )
    .map(([schema]) => schema ?? "")
    .filter((schema) => names.includes(schema));
  const checkouts = new Map<string, string[]>();
  if (marked.length > 0) {
    const rows = await mysql(
      marked.map((schema) => `(select '${schema}', path from \`${schema}\`.${rules.markerTable})`).join(" union all "),
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
    })),
  );
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
      const value = (key: string) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
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
): Promise<WorktreeFacts> {
  const git = (...args: string[]) => run("git", ["--no-optional-locks", "-C", worktree.path, ...args]);
  const [status, gitDir, merged, pr] = await Promise.all([
    git("status", "--porcelain"),
    git("rev-parse", "--absolute-git-dir"),
    git("merge-base", "--is-ancestor", "HEAD", `origin/${baseBranch}`),
    worktree.branch
      ? run("gh", ["pr", "list", "--head", worktree.branch, "--state", "all", "--json", "state,headRefOid", "--limit", "1"], {
          cwd: root,
        })
      : Promise.resolve(undefined),
  ]);

  const activityFiles = ["index", "HEAD", "logs/HEAD"].map((name) => join(gitDir.stdout.trim(), name));
  const lastActivityMs = Math.max(
    ...activityFiles.map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0),
  );
  if (gitDir.exitCode !== 0 || lastActivityMs === 0) throw new Error(`cannot read git state for ${worktree.path}`);
  if (pr && pr.exitCode !== 0) throw new Error(`gh pr list failed for ${worktree.branch}`);

  return {
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    locked: worktree.locked,
    dirty: status.exitCode !== 0 || status.stdout.trim() !== "",
    inUse: isInUse(worktree.path, openPaths),
    lastActivityMs,
    mergedIntoBase: merged.exitCode === 0,
    pr: pr ? JSON.parse(pr.stdout || "[]")[0] : undefined,
  };
}

/** A worktree's native build output as absolute paths; empty while any of it changed within the idle window. */
async function idleNativeBuilds(worktree: string): Promise<string[]> {
  const rule = MAC_WATCHER.storage.nativeBuilds;
  const listed = await run("git", ["-C", worktree, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (listed.exitCode !== 0) throw new Error(`cannot list ignored files in ${worktree}`);
  const { outputs, dependencyDirs } = nativeBuildCandidates(listed.stdout.split("\0").filter(Boolean), rule);

  let dependencyBuilds: string[] = [];
  if (dependencyDirs.length > 0) {
    const builds = rule.dependencies.builds.flatMap((pattern, index) => [...(index > 0 ? ["-o"] : []), "-path", pattern]);
    const dirs = dependencyDirs.map((dir) => join(worktree, dir));
    const found = await run("find", [...dirs, "-type", "d", "(", ...builds, ")", "-prune", "-print0"], { timeout: 180_000 });
    if (found.exitCode !== 0) throw new Error(`cannot search dependencies in ${worktree}`);
    dependencyBuilds = found.stdout.split("\0").filter(Boolean);
  }
  const paths = [...outputs.map((path) => join(worktree, path).replace(/\/$/, "")), ...dependencyBuilds];
  if (paths.length === 0) return [];

  // One recent file means a build may still need the rest; find stops at the first.
  const recent = await run("find", [...paths, "-mmin", `-${rule.idleHours * 60}`, "-print", "-quit"], { timeout: 180_000 });
  if (recent.stdout.trim()) return [];
  if (recent.exitCode !== 0) throw new Error(`cannot check native build ages in ${worktree}`);
  return paths;
}

// =============================================================================
// Run
// =============================================================================

export async function pruneStorage(options: { home: string; now: Date; dryRun: boolean }): Promise<PruneReport> {
  const { home, dryRun } = options;
  const now = options.now.getTime();
  const rules = MAC_WATCHER.storage;
  const report: PruneReport = {
    at: options.now.toISOString(),
    dryRun,
    freedBytes: 0,
    deleted: [],
    archived: { files: 0, bytes: 0 },
    temp: { entries: 0, bytes: 0 },
    worktreesRemoved: [],
    worktreesKept: [],
    nativeBuildsCleared: [],
    codexThreadsDeleted: { threads: 0, bytes: 0 },
    testDatabasesDropped: [],
    devicesDeleted: [],
    skipped: [],
    errors: [],
  };
  const attempt = async (label: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      report.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  };

  const openPaths = await listOpenPaths();
  if (!openPaths) {
    report.skipped.push("lsof failed, so nothing was touched");
    return report;
  }

  for (const rule of rules.deleteChildren) {
    await attempt(rule.path, async () => {
      const match = "match" in rule ? rule.match : undefined;
      const children = (await childrenWithAge(join(home, rule.path))).filter(
        (child) => !match || match.test(child.path),
      );
      for (const child of olderThan(children, rule.days, now)) {
        if (isInUse(child.path, openPaths)) continue;
        const bytes = await sizeBytes(child.path);
        if (!dryRun) await rm(child.path, { recursive: true, force: true });
        report.deleted.push({ path: child.path, bytes });
        report.freedBytes += bytes;
      }
    });
  }

  await attempt("temp", async () => {
    const uid = process.getuid?.() ?? -1;
    const dirs = ["/private/tmp", await userTempDir()].filter((dir): dir is string => Boolean(dir && existsSync(dir)));
    for (const dir of dirs.map((dir) => realpathSync(dir))) {
      const kept = new Set([...childrenInUse(dir, openPaths), ...(await protectedChildren(dir))]);
      const leftovers = tempLeftovers(await tempEntries(dir, uid), { ...rules.temp, now }).filter(
        (entry) => !kept.has(entry.path),
      );
      const bytes = await totalSizeBytes(leftovers.map((entry) => entry.path));
      if (!dryRun) {
        for (const entry of leftovers) await attempt(entry.path, () => rm(entry.path, { recursive: true, force: true }));
      }
      report.temp.entries += leftovers.length;
      report.temp.bytes += bytes;
      report.freedBytes += bytes;
    }
  });

  if (!archiveMounted(home)) {
    report.skipped.push(`${rules.archiveVolume} is not mounted, so nothing was archived`);
  } else {
    for (const rule of rules.archiveFiles) {
      await attempt(rule.path, async () => {
        const source = join(home, rule.path);
        const files = olderThan(await filesWithAge(source), rule.days, now).filter(
          (file) => !isInUse(file.path, openPaths),
        );
        for (const file of files) {
          if (!dryRun) await moveFile(file.path, join(rules.archiveRoot, rule.to, relative(source, file.path)));
          report.archived.files += 1;
          report.archived.bytes += file.size;
          report.freedBytes += file.size;
        }
        if (!dryRun) await removeEmptyParents(files.map((file) => file.path), source);
      });
    }
  }

  const codexState = codexDatabase(home, "state");
  const codexHistory = codexDatabase(home, "thread_history");
  if (codexState && codexHistory) {
    await attempt("codex threads", async () => {
      const idle = codexThreadsToDelete(await codexThreadFacts(codexState), { idleDays: rules.codex.threadIdleDays, now });
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
      if (left.length > 0) throw new Error(`codex delete failed for ${left.length} threads, such as ${left[0]}`);
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
    const releases = codexReleasesToDelete(await childrenWithAge(join(standalone, "releases")), current, rules.codex.keepReleases);
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
    const devices = [...(Bun.which("xcrun") ? await simulatorFacts() : []), ...(await emulatorFacts(home))];
    const unused = devicesToDelete(devices, { ...rules.devices, now }).filter((device) => !isInUse(device.path, openPaths));
    for (const device of unused) {
      await attempt(`${device.kind} ${device.name}`, async () => {
        const bytes = await sizeBytes(device.path);
        if (!dryRun && device.kind === "simulator") {
          const deleted = await run("xcrun", ["simctl", "delete", device.id]);
          if (deleted.exitCode !== 0) throw new Error(deleted.stderr.trim() || "simctl delete failed");
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

  for (const project of ACTIVE_PROJECTS) {
    if (!existsSync(project.canonicalRoot)) continue;
    await attempt(project.name, async () => {
      const listed = await run("git", ["-C", project.canonicalRoot, "worktree", "list", "--porcelain"]);
      if (listed.exitCode !== 0) throw new Error("git worktree list failed");
      const agentWorktrees = parseWorktreeList(listed.stdout).filter((worktree) =>
        rules.agentWorktreeDirs.some((dir) => worktree.path.includes(dir)),
      );
      for (const worktree of agentWorktrees) {
        await attempt(worktree.path, async () => {
          if (!existsSync(worktree.path)) return;
          const facts = await worktreeFacts(project.canonicalRoot, project.baseBranch, worktree, openPaths);
          const decision = decideWorktree(facts, now, rules.worktreeIdleDays);
          if (!decision.remove) {
            const idleDays = Math.max(0, Math.floor((now - facts.lastActivityMs) / DAY_MS));
            report.worktreesKept.push({ path: worktree.path, reason: decision.reason, idleDays });

            if (facts.inUse || now - facts.lastActivityMs < rules.nativeBuilds.idleHours * HOUR_MS) return;
            const builds = await idleNativeBuilds(worktree.path);
            if (builds.length === 0) return;
            const buildBytes = await totalSizeBytes(builds);
            if (!dryRun) for (const path of builds) await rm(path, { recursive: true, force: true });
            report.nativeBuildsCleared.push({ path: worktree.path, bytes: buildBytes });
            report.freedBytes += buildBytes;
            return;
          }
          const bytes = await sizeBytes(worktree.path);
          if (!dryRun) {
            const removed = await run("git", ["-C", project.canonicalRoot, "worktree", "remove", worktree.path]);
            if (removed.exitCode !== 0) throw new Error(removed.stderr.trim() || "git worktree remove failed");
          }
          report.worktreesRemoved.push({ path: worktree.path, bytes });
          report.freedBytes += bytes;
        });
      }
    });
  }

  await attempt("test databases", async () => {
    const mysql = mysqlClient(home);
    const databases = mysql && (await testDatabaseFacts(mysql));
    if (!mysql || !databases) {
      report.skipped.push("MySQL is not reachable, so no test database was checked");
      return;
    }
    const doomed = testDatabasesToDrop(databases, {
      now,
      unmarkedDays: rules.testDatabases.unmarkedDays,
      prefixes: ACTIVE_PROJECTS.map((project) => `${project.name.toLowerCase()}_`),
      checkoutExists: existsSync,
    });
    // One call per database, so a slow drop on a busy disk never times out the rest.
    for (const database of doomed) {
      await attempt(`test database ${database.name}`, async () => {
        if (!dryRun && !(await mysql(`drop database if exists \`${database.name}\``))) throw new Error("drop failed");
        report.testDatabasesDropped.push({ name: database.name, bytes: database.bytes });
        report.freedBytes += database.bytes;
      });
    }
  });

  return report;
}
