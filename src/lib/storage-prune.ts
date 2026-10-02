import { existsSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { execa } from "execa";
import { z } from "zod";

import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { MAC_WATCHER } from "../../config/mac-watcher";

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * A worktree goes only when removing it loses nothing: its commits are on the base branch or in a finished PR, it has no
 * uncommitted or untracked files, and nobody is using it. The branch itself is kept, so the commits stay reachable.
 */
export function decideWorktree(facts: WorktreeFacts, now: number, idleDays: number): WorktreeDecision {
  if (facts.locked) return { remove: false, reason: "locked" };
  if (facts.inUse) return { remove: false, reason: "in use by a running process" };
  if (facts.dirty) return { remove: false, reason: "uncommitted changes" };

  const idle = (now - facts.lastActivityMs) / DAY_MS;
  if (idle < idleDays) return { remove: false, reason: `active ${Math.floor(idle)}d ago` };

  if (facts.mergedIntoBase) return { remove: true };
  if (!facts.pr) return { remove: false, reason: facts.branch ? "no PR" : "detached HEAD" };
  if (facts.pr.state === "OPEN") return { remove: false, reason: "PR open" };
  if (facts.pr.headRefOid !== facts.head) return { remove: false, reason: "local commits not in the PR" };
  return { remove: true };
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
  worktreesRemoved: z.array(z.object({ path: z.string(), bytes: z.number() })),
  worktreesKept: z.array(z.object({ path: z.string(), reason: z.string(), idleDays: z.number() })),
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
    `worktrees removed ${report.worktreesRemoved.length}`,
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
    worktreesRemoved: [],
    worktreesKept: [],
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

  await attempt("simulators", async () => {
    if (!dryRun && Bun.which("xcrun")) await run("xcrun", ["simctl", "delete", "unavailable"]);
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
            const idleDays = Math.floor((now - facts.lastActivityMs) / DAY_MS);
            report.worktreesKept.push({ path: worktree.path, reason: decision.reason, idleDays });
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

  return report;
}
