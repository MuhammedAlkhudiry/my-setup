import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeMergedWorktree } from "./merged-worktree";

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** A canonical clone plus one agent worktree whose branch head was merged. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "merged-worktree-test-")));
  directories.push(base);
  const home = join(base, "home");
  const root = join(base, "project");
  const worktree = join(home, ".t3/worktrees/project/t3-done");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, ".t3/worktrees/project"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  git(root, "worktree", "add", "-q", "-b", "feat/done", worktree);
  writeFileSync(join(worktree, "feature.txt"), "done\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-qm", "feature");
  mkdirSync(join(worktree, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(worktree, "node_modules/pkg/index.js"), "");

  const head = git(worktree, "rev-parse", "HEAD");
  const remove = (open: string[] = []) =>
    removeMergedWorktree({
      canonicalRoot: root,
      head,
      home,
      openPaths: async () => new Set(open),
    });
  return { root, worktree, head, remove };
}

test("a merged PR's clean worktree at its merged head is removed with its installed packages, keeping the branch", async () => {
  const f = fixture();

  expect(await f.remove()).toBe(f.worktree);
  expect(existsSync(f.worktree)).toBe(false);
  expect(git(f.root, "rev-parse", "feat/done")).toBe(f.head);
});

test("uncommitted or untracked files keep the worktree", async () => {
  const f = fixture();
  writeFileSync(join(f.worktree, "notes.txt"), "unsaved\n");

  await expect(f.remove()).rejects.toThrow("uncommitted changes");
  expect(existsSync(join(f.worktree, "notes.txt"))).toBe(true);
});

test("a commit after the merged head keeps the worktree", async () => {
  const f = fixture();
  writeFileSync(join(f.worktree, "more.txt"), "later\n");
  git(f.worktree, "add", ".");
  git(f.worktree, "commit", "-qm", "unpushed");

  expect(await f.remove()).toBeUndefined();
  expect(existsSync(f.worktree)).toBe(true);
});

test("a live process in the worktree keeps it", async () => {
  const f = fixture();

  await expect(f.remove([join(f.worktree, "node_modules")])).rejects.toThrow("in use");
  expect(existsSync(f.worktree)).toBe(true);
});

test("a locked worktree stays", async () => {
  const f = fixture();
  git(f.root, "worktree", "lock", f.worktree);

  await expect(f.remove()).rejects.toThrow("locked");
  expect(existsSync(f.worktree)).toBe(true);
});

test("the canonical clone is never a candidate, even at the merged head", async () => {
  const f = fixture();
  git(f.worktree, "checkout", "-q", "--detach");
  git(f.root, "merge", "-q", "--ff-only", "feat/done");

  expect(await f.remove()).toBeUndefined();
  expect(existsSync(f.root)).toBe(true);
});
