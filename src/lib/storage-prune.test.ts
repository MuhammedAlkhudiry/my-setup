import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  type TestDatabaseFacts,
  type WorktreeFacts,
  decideWorktree,
  isInUse,
  olderThan,
  parseWorktreeList,
  testDatabasesToDrop,
} from "./storage-prune";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-02T12:00:00Z");

const landed: WorktreeFacts = {
  path: "/repo/.claude/worktrees/done",
  branch: "feat/done",
  head: "abc",
  locked: false,
  dirty: false,
  inUse: false,
  lastActivityMs: now - 8 * DAY,
  mergedIntoBase: false,
  pr: { state: "MERGED", headRefOid: "abc" },
};

test("only entries past the age limit expire", () => {
  const entries = [
    { path: "old", mtimeMs: now - 4 * DAY },
    { path: "fresh", mtimeMs: now - 2 * DAY },
  ];

  expect(olderThan(entries, 3, now).map((entry) => entry.path)).toEqual(["old"]);
});

test("a path counts as in use when anything inside it is open, but not a sibling with the same prefix", () => {
  const open = new Set([join("/repo", "wt", "node_modules", "x.js"), join("/repo", "wt-other")]);

  expect(isInUse(join("/repo", "wt"), open)).toBe(true);
  expect(isInUse(join("/repo", "wt-ot"), open)).toBe(false);
  expect(isInUse(join("/repo", "wt-other"), open)).toBe(true);
});

test("a clean, idle worktree whose PR merged at its current commit is removed", () => {
  expect(decideWorktree(landed, now, 7)).toEqual({ remove: true });
  expect(decideWorktree({ ...landed, pr: undefined, mergedIntoBase: true }, now, 7)).toEqual({
    remove: true,
  });
});

test("worktrees that could still hold work are kept with a reason", () => {
  const keep = (facts: Partial<WorktreeFacts>) => decideWorktree({ ...landed, ...facts }, now, 7);

  expect(keep({ locked: true })).toEqual({ remove: false, reason: "locked" });
  expect(keep({ inUse: true })).toEqual({ remove: false, reason: "in use by a running process" });
  expect(keep({ dirty: true })).toEqual({ remove: false, reason: "uncommitted changes" });
  expect(keep({ lastActivityMs: now - 2 * DAY })).toEqual({
    remove: false,
    reason: "active 2d ago",
  });
  expect(keep({ pr: { state: "OPEN", headRefOid: "abc" } })).toEqual({
    remove: false,
    reason: "PR open",
  });
  expect(keep({ head: "def" })).toEqual({ remove: false, reason: "local commits not in the PR" });
  expect(keep({ pr: undefined })).toEqual({ remove: false, reason: "no PR" });
  expect(keep({ pr: undefined, branch: undefined })).toEqual({
    remove: false,
    reason: "detached HEAD",
  });
});

test("git worktree porcelain output is parsed, including locked worktrees with a reason", () => {
  const porcelain = [
    "worktree /repo\nHEAD 111\nbranch refs/heads/main",
    "worktree /repo/.claude/worktrees/a\nHEAD 222\nbranch refs/heads/feat/a\nlocked claude agent",
    "worktree /repo/.claude/worktrees/b\nHEAD 333\ndetached",
  ].join("\n\n");

  expect(parseWorktreeList(porcelain)).toEqual([
    { path: "/repo", head: "111", branch: "main", locked: false },
    { path: "/repo/.claude/worktrees/a", head: "222", branch: "feat/a", locked: true },
    { path: "/repo/.claude/worktrees/b", head: "333", branch: undefined, locked: false },
  ]);
});

test("test databases go with their workers' copies when the checkout that built them is gone", () => {
  const fresh = now - DAY;
  const stale = now - 30 * DAY;
  const db = (name: string, checkout: string | undefined, touchedMs: number): TestDatabaseFacts => ({
    name,
    checkouts: checkout ? [checkout] : [],
    touchedMs,
    bytes: 1,
  });
  const databases = [
    db("harium_gone_1a2b3c4d_testing", "/repo/.claude/worktrees/gone", fresh),
    db("harium_gone_1a2b3c4d_testing_test_1", "/repo/.claude/worktrees/gone", fresh),
    db("harium_live_5e6f7a8b_testing", "/repo/.claude/worktrees/live", stale),
    { ...db("harium_moved_9c0d1e2f_testing", "/repo/.claude/worktrees/old-path", fresh), checkouts: ["/old", "/repo/live"] },
    db("awraq_old_testing", undefined, stale),
    db("awraq_old_testing_test_2", undefined, stale),
    db("awraq_recent_testing", undefined, fresh),
    db("books_testing", undefined, stale),
  ];

  const dropped = testDatabasesToDrop(databases, {
    now,
    unmarkedDays: 14,
    prefixes: ["awraq_", "harium_"],
    checkoutExists: (path) => path.endsWith("/live"),
  });

  expect(dropped.map((database) => database.name)).toEqual([
    "harium_gone_1a2b3c4d_testing",
    "harium_gone_1a2b3c4d_testing_test_1",
    "awraq_old_testing",
    "awraq_old_testing_test_2",
  ]);
});
