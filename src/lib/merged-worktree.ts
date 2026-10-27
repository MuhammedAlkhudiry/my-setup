import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";

import { MAC_WATCHER } from "../../config/mac-watcher";
import { mergeQueueDirectory } from "./merge-queue";
import { isInUse, listOpenPaths, parseWorktreeList } from "./storage-prune";
import { timedCommand } from "./timed-command";
import { cleanupWorktreeAllowed } from "./worktree-cleanup";

/**
 * Right after the queue merges a PR, removes the agent worktree still checked out at exactly the merged head. It stays
 * when it has uncommitted or untracked files, a later commit, a lock, or a process holding it, and the canonical clone
 * and queue candidates are never candidates. The branch stays, so the work can be resumed; the watcher's idle prune
 * handles any worktree kept here.
 */
export async function removeMergedWorktree(options: {
  canonicalRoot: string;
  head: string;
  home: string;
  openPaths?: () => Promise<Set<string> | undefined>;
}): Promise<string | undefined> {
  const { canonicalRoot, head, home } = options;
  const git = (...args: string[]) => timedCommand("git", args, { timeout: 60_000 });

  const listed = await git("-C", canonicalRoot, "worktree", "list", "--porcelain");
  if (listed.exitCode !== 0) throw new Error("git worktree list failed");
  const root = realpathSync(canonicalRoot);
  const queue = mergeQueueDirectory();
  const worktree = parseWorktreeList(listed.stdout).find(
    (tree) =>
      tree.head === head &&
      tree.branch &&
      existsSync(tree.path) &&
      realpathSync(tree.path) !== root &&
      !`${tree.path}${sep}`.startsWith(`${queue}${sep}`) &&
      MAC_WATCHER.storage.agentWorktreeDirs.some((dir) => tree.path.includes(dir)) &&
      cleanupWorktreeAllowed(tree.path, canonicalRoot, home),
  );
  if (!worktree) return undefined;
  if (worktree.locked) throw new Error(`${worktree.path} is locked`);

  const status = await git("-C", worktree.path, "status", "--porcelain");
  if (status.exitCode !== 0 || status.stdout.trim())
    throw new Error(`${worktree.path} has uncommitted changes`);
  const open = await (options.openPaths ?? listOpenPaths)();
  if (!open) throw new Error("cannot list open files");
  if (isInUse(worktree.path, open) || isInUse(realpathSync(worktree.path), open))
    throw new Error(`${worktree.path} is in use by a running process`);

  // Without --force, git refuses again if anything changed since the checks above.
  const removed = await git("-C", canonicalRoot, "worktree", "remove", worktree.path);
  if (removed.exitCode !== 0)
    throw new Error(removed.stderr.trim() || "git worktree remove failed");
  return worktree.path;
}
