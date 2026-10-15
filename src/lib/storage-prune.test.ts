import { expect, test } from "bun:test";
import { join } from "node:path";

import { MAC_WATCHER } from "../../config/mac-watcher";

import {
  type CodexThreadFacts,
  type DeviceFacts,
  type TempEntry,
  type TestDatabaseFacts,
  type WorktreeFacts,
  childrenInUse,
  codexReleasesToDelete,
  codexThreadsToDelete,
  decideWorktree,
  devicesToDelete,
  isInUse,
  nativeBuildCandidates,
  olderThan,
  parseWorktreeList,
  staleChildren,
  tempLeftovers,
  testDatabasesToDrop,
  xcodeWorkspacePath,
} from "./storage-prune";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-02T12:00:00Z");
const idleDays = { landed: 1, abandoned: 7 };

const landed: WorktreeFacts = {
  path: "/repo/.claude/worktrees/done",
  branch: "feat/done",
  head: "abc",
  locked: false,
  dirty: false,
  inUse: false,
  lastActivityMs: now - 8 * DAY,
  mergedIntoBase: false,
  lastCommitMs: now - 8 * DAY,
  recentFiles: false,
  prFinishedAt: new Date(now - 8 * DAY).toISOString(),
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

test("a clean worktree goes a day after a finished PR; ancestry alone keeps fresh work", () => {
  const remove = (facts: Partial<WorktreeFacts>) =>
    decideWorktree({ ...landed, ...facts }, now, idleDays);

  expect(remove({ lastActivityMs: now - 2 * DAY })).toEqual({ remove: true });
  expect(remove({ pr: undefined, mergedIntoBase: true, lastActivityMs: now - 2 * DAY })).toEqual({
    remove: false,
    reason: "default-branch ancestry alone does not prove finished work",
  });
  expect(remove({ pr: { state: "CLOSED", headRefOid: "abc" } })).toEqual({ remove: true });
  expect(remove({ lastActivityMs: now - DAY / 2 })).toEqual({
    remove: false,
    reason: "landed, active 0d ago",
  });
});

test("a clean branch that never landed goes once abandoned, since the kept branch still holds its commits", () => {
  const decide = (facts: Partial<WorktreeFacts>) =>
    decideWorktree({ ...landed, ...facts }, now, idleDays);

  expect(decide({ pr: undefined })).toEqual({ remove: true });
  expect(decide({ head: "def" })).toEqual({ remove: true });
  expect(decide({ pr: undefined, lastActivityMs: now - 3 * DAY })).toEqual({
    remove: false,
    reason: "active 3d ago",
  });
});

test("a thread that is not running keeps a worktree only until its work lands", () => {
  const decide = (facts: Partial<WorktreeFacts>) =>
    decideWorktree({ ...landed, threads: ["Settled thread"], ...facts }, now, idleDays);

  expect(decide({ lastActivityMs: now - 2 * DAY })).toEqual({ remove: true });
  expect(decide({ pr: undefined, lastActivityMs: now - 30 * DAY })).toEqual({
    remove: false,
    reason: "T3 thread: Settled thread",
  });
});

test("worktrees that could still hold work are kept with a reason", () => {
  const keep = (facts: Partial<WorktreeFacts>) =>
    decideWorktree({ ...landed, ...facts }, now, idleDays);

  expect(keep({ locked: true })).toEqual({ remove: false, reason: "locked" });
  expect(keep({ inUse: true })).toEqual({ remove: false, reason: "in use by a running process" });
  expect(keep({ dirty: true })).toEqual({ remove: false, reason: "uncommitted changes" });
  expect(
    keep({ pr: { state: "OPEN", headRefOid: "abc" }, lastActivityMs: now - 30 * DAY }),
  ).toEqual({
    remove: false,
    reason: "PR open",
  });
  expect(keep({ pr: undefined, branch: undefined, lastActivityMs: now - 30 * DAY })).toEqual({
    remove: false,
    reason: "detached HEAD",
  });
});

test("scheduled cleanup respects recent PRs, commits, files and detached heads", () => {
  for (const change of [
    { lastCommitMs: now - 1000 },
    { prFinishedAt: new Date(now - 1000).toISOString() },
    { recentFiles: true },
  ])
    expect(decideWorktree({ ...landed, ...change }, now, idleDays)).toEqual({
      remove: false,
      reason: "four-hour activity grace period",
    });
  expect(decideWorktree({ ...landed, branch: undefined }, now, idleDays)).toEqual({
    remove: false,
    reason: "detached HEAD",
  });
});

test("temp leftovers are this user's stale files and folders, never sockets, folders holding one, or skipped names", () => {
  const entry = (name: string, facts: Partial<TempEntry> = {}): TempEntry => ({
    path: join("/tmp", name),
    name,
    kind: "directory",
    mtimeMs: now - 3 * DAY,
    ownedByUser: true,
    holdsSocket: false,
    ...facts,
  });
  const entries = [
    entry("harium-film"),
    entry(".1626a762-1AF.shell-quote"),
    entry("notes.txt", { kind: "file" }),
    entry("fresh", { mtimeMs: now - DAY }),
    entry("powerlog", { ownedByUser: false }),
    entry("mysqlx.sock", { kind: "other" }),
    entry("mysqlx.sock.lock", { kind: "file" }),
    entry("cc-socks", { holdsSocket: true }),
    entry("com.apple.launchd.abc"),
    entry("tmux-501"),
  ];

  const leftovers = tempLeftovers(entries, { days: 2, skip: MAC_WATCHER.storage.temp.skip, now });

  expect(leftovers.map((leftover) => leftover.name)).toEqual([
    "harium-film",
    ".1626a762-1AF.shell-quote",
    "notes.txt",
  ]);
});

test("simulators and emulators go once stopped and unused for a day, except the devices to keep", () => {
  const device = (name: string, facts: Partial<DeviceFacts> = {}): DeviceFacts => ({
    kind: "simulator",
    id: name,
    name,
    running: false,
    path: join("/devices", name),
    mtimeMs: now - 2 * DAY,
    ...facts,
  });
  const devices = [
    device("Harium Voice Try"),
    device("Harium_E2E", { kind: "emulator" }),
    device("Harium Path", { running: true }),
    device("Harium Feed Labels", { mtimeMs: now - DAY / 2 }),
    device("Awraq Main"),
    device("Harium_Main", { kind: "emulator" }),
  ];

  const deleted = devicesToDelete(devices, { ...MAC_WATCHER.storage.devices, now });

  expect(deleted.map((entry) => entry.name)).toEqual(["Harium Voice Try", "Harium_E2E"]);
});

test("native build output is the generated native projects and build folders git ignores, never other output", () => {
  const ignored = [
    "harium-app/.expo/",
    "harium-app/android/",
    "harium-app/ios/",
    "harium-app/modules/focus-activity/android/build/",
    "harium-app/modules/widgets/ios/Pods/",
    "harium-app/node_modules/",
    "harium/public/build/",
    "harium/vendor/",
    "android-notes.md",
    "node_modules/",
  ];

  const { outputs, dependencyDirs } = nativeBuildCandidates(
    ignored,
    MAC_WATCHER.storage.nativeBuilds,
  );

  expect(outputs).toEqual([
    "harium-app/android/",
    "harium-app/ios/",
    "harium-app/modules/focus-activity/android/build/",
    "harium-app/modules/widgets/ios/Pods/",
  ]);
  expect(dependencyDirs).toEqual(["harium-app/node_modules/", "node_modules/"]);
});

test("old Codex versions go, except the current one and the newest other", () => {
  const release = (name: string, ageDays: number) => ({
    path: join("/releases", name),
    mtimeMs: now - ageDays * DAY,
  });
  const releases = [
    release("0.159.0", 9),
    release("0.162.1", 2),
    release("0.160.1", 4),
    release("0.156.0", 20),
  ];

  const deleted = codexReleasesToDelete(releases, "0.162.1", 2);

  expect(deleted.map((entry) => entry.path)).toEqual([
    join("/releases", "0.159.0"),
    join("/releases", "0.156.0"),
  ]);
  expect(codexReleasesToDelete(releases, "0.159.0", 1)).toHaveLength(3);
});

test("idle Codex threads go only once the archive took their session file", () => {
  const thread = (id: string, idleDays: number, sessionFileExists = false): CodexThreadFacts => ({
    id,
    updatedMs: now - idleDays * DAY,
    sessionFileExists,
  });
  const threads = [
    thread("archived", 15),
    thread("not archived yet", 30, true),
    thread("recent", 3),
    thread("unknown", Number.NaN),
  ];

  const deleted = codexThreadsToDelete(threads, { idleDays: 14, now });

  expect(deleted.map((entry) => entry.id)).toEqual(["archived"]);
});

test("the children in use are the direct children holding any open path", () => {
  const open = new Set([
    "/tmp/run/out/video.mp4",
    "/tmp/run",
    "/tmp/other.log",
    "/tmpfile",
    "/var/x",
  ]);

  expect([...childrenInUse("/tmp", open)].sort()).toEqual(["/tmp/other.log", "/tmp/run"]);
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
  const db = (
    name: string,
    checkout: string | undefined,
    touchedMs: number,
  ): TestDatabaseFacts => ({
    name,
    checkouts: checkout ? [checkout] : [],
    touchedMs,
    bytes: 1,
  });
  const databases = [
    db("harium_gone_1a2b3c4d_testing", "/repo/.claude/worktrees/gone", fresh),
    db("harium_gone_1a2b3c4d_testing_test_1", "/repo/.claude/worktrees/gone", fresh),
    db("harium_live_5e6f7a8b_testing", "/repo/.claude/worktrees/live", stale),
    {
      ...db("harium_moved_9c0d1e2f_testing", "/repo/.claude/worktrees/old-path", fresh),
      checkouts: ["/old", "/repo/live"],
    },
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

test("a build folder goes after the age limit, or after an idle hour once its project is gone", () => {
  const HOUR = 60 * 60 * 1000;
  const folder = (name: string, idle: number, projectGone: boolean) => ({ path: `/dd/${name}`, mtimeMs: now - idle, projectGone });
  const children = [
    folder("old", 15 * DAY, false),
    folder("live", 2 * DAY, false),
    folder("gone", 2 * HOUR, true),
    folder("gone-busy", 30 * 60 * 1000, true),
  ];

  expect(staleChildren(children, { days: 14, projectGoneHours: 1, now }).map((child) => child.path)).toEqual(["/dd/old", "/dd/gone"]);
  expect(staleChildren(children, { days: 14, now }).map((child) => child.path)).toEqual(["/dd/old"]);
});

test("the project path is read from a DerivedData info.plist", () => {
  const plist = `<dict>
  <key>LastAccessedDate</key>
  <date>2026-10-10T21:00:09Z</date>
  <key>WorkspacePath</key>
  <string>/Users/test/.t3/worktrees/app/R&amp;D/ios/App.xcworkspace</string>
</dict>`;

  expect(xcodeWorkspacePath(plist)).toBe("/Users/test/.t3/worktrees/app/R&D/ios/App.xcworkspace");
  expect(xcodeWorkspacePath("<dict></dict>")).toBeUndefined();
});
