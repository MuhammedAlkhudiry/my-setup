import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAC_WATCHER } from "../../config/mac-watcher";

import {
  type CodexThreadFacts,
  type DeviceFacts,
  type FileStorageRules,
  type TempEntry,
  type TestDatabaseFacts,
  type WorktreeFacts,
  archiveWorktree,
  STORAGE_WORKTREE_PROJECTS,
  childrenInUse,
  codexReleasesToDelete,
  codexThreadsToDelete,
  decideWorktree,
  devicesToDelete,
  isInUse,
  idleNativeBuilds,
  nativeBuildCandidates,
  olderThan,
  parseWorktreeList,
  pruneFileStorage,
  staleChildren,
  tempLeftovers,
  toolCacheIdle,
  testDatabasesToDrop,
  testDatabaseRunInProgress,
  testRunInProgress,
  xcodeWorkspacePath,
} from "./storage-prune";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-02T12:00:00Z");
const idleDays = { landed: 1, abandoned: 7, thread: 3 };

async function withStorageFixture(
  run: (fixture: {
    home: string;
    rules: FileStorageRules;
    file: (path: string, ageDays: number) => Promise<string>;
  }) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "storage-prune-"));
  try {
    await run({
      home,
      rules: { ...MAC_WATCHER.storage, archiveRoot: join(home, "archive") },
      file: async (path, ageDays) => {
        const fullPath = join(home, path);
        await mkdir(join(fullPath, ".."), { recursive: true });
        await writeFile(fullPath, "session or cache content");
        const touched = new Date(now - ageDays * DAY);
        await utimes(fullPath, touched, touched);
        return fullPath;
      },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("low-space rules start strictly below 30 GiB; the 14-day archive still runs above it", async () => {
  await withStorageFixture(async ({ home, rules, file }) => {
    await file(".codex/sessions/2026/09/01/old.jsonl", 15);
    await file(".codex/sessions/2026/09/28/recent.jsonl", 4);
    await file("Library/Caches/Google/Chrome/Default/Cache/Cache_Data/old", 4);
    for (const freeBytes of [31 * 1024 ** 3, 30 * 1024 ** 3, undefined]) {
      const result = await pruneFileStorage({
        home,
        rules,
        now,
        dryRun: true,
        freeBytes,
        openPaths: new Set(),
        archiveMounted: true,
      });
      expect(result.archived.files).toBe(1);
      expect(result.lowSpaceArchived.files).toBe(0);
      expect(result.browserCachesPruned.files).toBe(0);
    }
    const result = await pruneFileStorage({
      home,
      rules,
      now,
      dryRun: true,
      freeBytes: 30 * 1024 ** 3 - 1,
      openPaths: new Set(),
      archiveMounted: true,
    });
    expect(result.archived.files).toBe(2);
    expect(result.lowSpaceArchived.files).toBe(2);
    expect(result.browserCachesPruned.files).toBe(1);
    expect(result.freedBytes).toBe(3 * Buffer.byteLength("session or cache content"));
    expect(await readFile(join(home, ".codex/sessions/2026/09/28/recent.jsonl"), "utf8")).toBe(
      "session or cache content",
    );
  });
});

test("low-space archiving preserves the date layout and skips open or younger session and cache files", async () => {
  await withStorageFixture(async ({ home, rules, file }) => {
    const session = ".codex/sessions/2026/09/28/closed.jsonl";
    await file(session, 1.01);
    const openSession = await file(".codex/sessions/2026/09/28/open.jsonl", 4);
    const fresh = await file(".codex/sessions/2026/09/30/fresh.jsonl", 0.5);
    const atLimit = await file(".codex/sessions/2026/09/29/at-limit.jsonl", 1);
    const cache = "Library/Caches/Google/Chrome/Default/Cache/Cache_Data";
    const oldCache = await file(`${cache}/old`, 4);
    const openCache = await file(`${cache}/open`, 4);
    const freshCache = await file(`${cache}/fresh`, 2);
    const result = await pruneFileStorage({
      home,
      rules,
      now,
      dryRun: false,
      freeBytes: 29 * 1024 ** 3,
      openPaths: new Set([openSession, openCache]),
      archiveMounted: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.lowSpaceArchived.files).toBe(1);
    expect(result.browserCachesPruned.files).toBe(1);
    expect(
      await readFile(join(rules.archiveRoot, "codex-sessions/2026/09/28/closed.jsonl"), "utf8"),
    ).toBe("session or cache content");
    expect(await Bun.file(join(home, session)).exists()).toBe(false);
    expect(await Bun.file(oldCache).exists()).toBe(false);
    for (const path of [openSession, fresh, atLimit, openCache, freshCache])
      expect(await Bun.file(path).exists()).toBe(true);
  });
});

test("an unmounted SSD keeps sessions locally while old browser caches can still be removed", async () => {
  await withStorageFixture(async ({ home, rules, file }) => {
    const session = await file(".codex/sessions/2026/09/01/closed.jsonl", 30);
    const cache = await file(
      ".t3/userdata/server-browser/profiles/default/Default/Code Cache/js/old",
      4,
    );
    const result = await pruneFileStorage({
      home,
      rules,
      now,
      dryRun: false,
      freeBytes: 0,
      openPaths: new Set(),
      archiveMounted: false,
    });
    expect(result.archived.files).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(await Bun.file(session).exists()).toBe(true);
    expect(await Bun.file(cache).exists()).toBe(false);
    expect(await readdir(home)).not.toContain("archive");
  });
});

test("only named browser cache folders are pruned, preserving profiles, cookies and login data", async () => {
  await withStorageFixture(async ({ home, rules, file }) => {
    const caches = [
      "Library/Application Support/Google/Chrome/Profile 1/GPUCache/old",
      "Library/Application Support/t3code/Partitions/t3code-preview-test/Cache/Cache_Data/old",
      "Library/Application Support/t3code-v2/Partitions/t3code-preview-test/Code Cache/js/old",
      ".t3/userdata/server-browser/profiles/default/Default/Cache/Cache_Data/old",
    ];
    const kept = [
      "Library/Application Support/Google/Chrome/Profile 1/Cookies",
      "Library/Application Support/Google/Chrome/Profile 1/Login Data",
      "Library/Application Support/t3code-v2/Partitions/t3code-preview-test/Network/Cookies",
      "Library/Application Support/t3code-v2/Partitions/t3code-preview-test/Local Storage/state",
      ".t3/userdata/server-browser/profiles/default/Default/Login Data",
    ];
    for (const path of [...caches, ...kept]) await file(path, 4);
    const result = await pruneFileStorage({
      home,
      rules,
      now,
      dryRun: false,
      freeBytes: 0,
      openPaths: new Set(),
      archiveMounted: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.browserCachesPruned.files).toBe(caches.length);
    for (const path of caches) expect(await Bun.file(join(home, path)).exists()).toBe(false);
    for (const path of kept) expect(await Bun.file(join(home, path)).exists()).toBe(true);
  });
});

test("an archive copy failure retains the original and reports no reclaimed space", async () => {
  await withStorageFixture(async ({ home, rules, file }) => {
    const session = await file(".codex/sessions/2026/09/28/closed.jsonl", 4);
    await writeFile(rules.archiveRoot, "not a directory");
    const result = await pruneFileStorage({
      home,
      rules,
      now,
      dryRun: false,
      freeBytes: 0,
      openPaths: new Set(),
      archiveMounted: true,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.freedBytes).toBe(0);
    expect(await readFile(session, "utf8")).toBe("session or cache content");
  });
});

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

  expect(remove({ lastActivityMs: now - 2 * DAY })).toEqual({ remove: true, archive: true });
  expect(remove({ pr: undefined, mergedIntoBase: true, lastActivityMs: now - 2 * DAY })).toEqual({
    remove: false,
    reason: "default-branch ancestry alone does not prove finished work",
  });
  expect(remove({ pr: { state: "CLOSED", headRefOid: "abc" } })).toEqual({
    remove: true,
    archive: true,
  });
  expect(remove({ lastActivityMs: now - DAY / 2 })).toEqual({
    remove: false,
    reason: "landed, active 0d ago",
  });
});

test("a clean branch that never landed goes once abandoned, since the kept branch still holds its commits", () => {
  const decide = (facts: Partial<WorktreeFacts>) =>
    decideWorktree({ ...landed, ...facts }, now, idleDays);

  expect(decide({ pr: undefined })).toEqual({ remove: true });
  expect(decide({ head: "def" })).toEqual({ remove: true, archive: true });
  expect(decide({ pr: undefined, lastActivityMs: now - 3 * DAY })).toEqual({
    remove: false,
    reason: "active 3d ago",
  });
});

test("a non-running thread's clean unmerged worktree expires at three idle days, keeping its branch", () => {
  const decide = (facts: Partial<WorktreeFacts>) =>
    decideWorktree({ ...landed, threads: ["Settled thread"], ...facts }, now, idleDays);

  expect(decide({ lastActivityMs: now - 2 * DAY })).toEqual({ remove: true, archive: true });
  expect(decide({ pr: undefined, lastActivityMs: now - 3 * DAY + 1 })).toEqual({
    remove: false,
    reason: "T3 thread: Settled thread",
  });
  expect(decide({ pr: undefined, lastActivityMs: now - 3 * DAY })).toEqual({ remove: true });
  expect(decide({ pr: undefined, filesChangedWithinIdleWindow: true })).toEqual({
    remove: false,
    reason: "files changed within idle window",
  });
  for (const facts of [
    { dirty: true },
    { inUse: true },
    { locked: true },
    { pr: { state: "OPEN" as const, headRefOid: "abc" } },
  ])
    expect(decide({ pr: undefined, ...facts }).remove).toBe(false);
  expect(decide({ pr: undefined, threads: [], lastActivityMs: now - 3 * DAY }).remove).toBe(false);
  expect(decide({ pr: undefined, threads: [], lastActivityMs: now - 7 * DAY }).remove).toBe(true);
});

test("worktrees that could still hold work are kept with a reason", () => {
  const keep = (facts: Partial<WorktreeFacts>) =>
    decideWorktree({ ...landed, ...facts }, now, idleDays);

  expect(keep({ locked: true })).toEqual({ remove: false, reason: "locked" });
  expect(keep({ inUse: true })).toEqual({ remove: false, reason: "in use by a running process" });
  expect(keep({ dirty: true, pr: undefined })).toEqual({
    remove: false,
    reason: "uncommitted changes",
  });
  expect(
    keep({ pr: { state: "OPEN", headRefOid: "abc" }, lastActivityMs: now - 30 * DAY }),
  ).toEqual({
    remove: false,
    reason: "PR open",
  });
  expect(keep({ pr: undefined, branch: undefined, lastActivityMs: now - 30 * DAY })).toEqual({
    remove: true,
  });
});

test("scheduled cleanup respects recent PRs, commits, files and detached activity", () => {
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
    remove: true,
  });
});

test("finished PRs archive diverged and dirty heads while locks, processes and recent activity still protect them", () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const facts = {
      ...landed,
      dirty: true,
      head: "unpublished",
      pr: { state, headRefOid: "published" },
    };
    expect(decideWorktree(facts, now, idleDays)).toEqual({ remove: true, archive: true });
    for (const protection of [
      { locked: true },
      { inUse: true },
      { recentFiles: true },
      { lastCommitMs: now },
      { prFinishedAt: null },
    ])
      expect(decideWorktree({ ...facts, ...protection }, now, idleDays).remove).toBe(false);
  }
});

test("detached checkouts require a full day without git or file activity and no changes", () => {
  const facts = { ...landed, branch: undefined, pr: undefined, mergedIntoBase: false };
  expect(decideWorktree({ ...facts, lastActivityMs: now - DAY }, now, idleDays)).toEqual({
    remove: true,
  });
  for (const protection of [
    { lastActivityMs: now - DAY + 1 },
    { filesChangedWithinDay: true },
    { dirty: true },
    { locked: true },
    { inUse: true },
  ])
    expect(decideWorktree({ ...facts, ...protection }, now, idleDays).remove).toBe(false);
});

test("storage cleanup includes the setup repository alongside product repositories", () => {
  expect(STORAGE_WORKTREE_PROJECTS.map((project) => project.canonicalRoot)).toContain(
    join(import.meta.dir, "../.."),
  );
  expect(STORAGE_WORKTREE_PROJECTS).toHaveLength(3);
});

test("verified worktree archives restore unpublished commits, staged and unstaged binary changes and untracked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-worktree-archive-"));
  const source = join(root, "source");
  await mkdir(source);
  const git = async (cwd: string, ...args: string[]) =>
    (await Bun.$`git -C ${cwd} ${args}`.quiet()).text().trim();
  try {
    await git(source, "init", "--quiet");
    await git(source, "config", "user.name", "Archive test");
    await git(source, "config", "user.email", "archive@example.invalid");
    await writeFile(join(source, "tracked"), "original\n");
    await git(source, "add", "tracked");
    await git(source, "commit", "--quiet", "-m", "unpublished commit");
    const head = await git(source, "rev-parse", "HEAD");
    await writeFile(join(source, "tracked"), "staged\n");
    await git(source, "add", "tracked");
    const binary = Buffer.from([0, 1, 255, 0, 2]);
    await writeFile(join(source, "tracked"), binary);
    await mkdir(join(source, "new folder"));
    await writeFile(join(source, "new folder/untracked"), "untracked work");
    await symlink("untracked", join(source, "new folder/link"));
    const options = {
      path: source,
      repo: "test",
      archiveRoot: join(root, "archive"),
      now: new Date(now),
      mounted: () => true,
    };
    await expect(archiveWorktree({ ...options, mounted: () => false })).rejects.toThrow(
      "not mounted",
    );
    expect(await readdir(root)).not.toContain("archive");
    const result = await archiveWorktree(options);
    expect(await result.unchanged()).toBe(true);
    const restored = join(root, "restored");
    await Bun.$`git clone --quiet ${join(result.archive, "commits.bundle")} ${restored}`.quiet();
    expect(await git(restored, "rev-parse", "HEAD")).toBe(head);
    await git(restored, "apply", join(result.archive, "changes.patch"));
    expect(await readFile(join(restored, "tracked"))).toEqual(binary);
    expect(await readFile(join(result.archive, "untracked/new folder/untracked"), "utf8")).toBe(
      "untracked work",
    );
    expect(await readlink(join(result.archive, "untracked/new folder/link"))).toBe("untracked");
    const manifest = JSON.parse(await readFile(join(result.archive, "manifest.json"), "utf8"));
    expect(manifest.unpublishedCommits).toContain(head);
    expect(manifest.verified).toBe(true);
    const archivedPatch = join(result.archive, "changes.patch");
    const savedPatch = await readFile(archivedPatch);
    await writeFile(archivedPatch, "corrupted archive");
    expect(await result.unchanged()).toBe(false);
    await writeFile(archivedPatch, savedPatch);
    expect(await result.unchanged()).toBe(true);
    await writeFile(join(source, "tracked"), "changed after verification");
    expect(await result.unchanged()).toBe(false);
    await expect(
      archiveWorktree({ ...options, archiveRoot: join(source, "tracked") }),
    ).rejects.toThrow();
    expect(await readFile(join(source, "tracked"), "utf8")).toBe("changed after verification");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("named tool caches expire after 24 hours; ordinary temp work and protected entries keep their existing rules", () => {
  const entry = (name: string, extra: Partial<TempEntry> = {}): TempEntry => ({
    path: join("/tmp", name),
    name,
    kind: "directory",
    ownedByUser: true,
    holdsSocket: false,
    mtimeMs: now - 1.5 * DAY,
    ...extra,
  });
  const entries = [
    ...[
      "jest_501",
      "jest_dx",
      "mago-workspace-abcd",
      "Instruments-run",
      "profile.trace",
      "metro-cache",
      "playwright-transform-cache-501",
      "node-compile-cache",
    ].map((name) => entry(name)),
    entry("ordinary-work"),
    entry("jest_fresh", { mtimeMs: now - DAY + 1 }),
    entry("jest_at_limit", { mtimeMs: now - DAY }),
    entry("jest_foreign", { ownedByUser: false }),
    entry("jest_service", { holdsSocket: true }),
    entry("jest_tool.lock"),
    entry("jest_tool.pid"),
    entry("old-ordinary", { mtimeMs: now - 3 * DAY }),
  ];
  const candidates = tempLeftovers(entries, { ...MAC_WATCHER.storage.temp, now });
  expect(candidates.map((entry) => entry.name)).toEqual([
    "jest_501",
    "jest_dx",
    "mago-workspace-abcd",
    "Instruments-run",
    "profile.trace",
    "metro-cache",
    "playwright-transform-cache-501",
    "node-compile-cache",
    "old-ordinary",
  ]);
  const held = childrenInUse(
    "/tmp",
    new Set(["/tmp/jest_501/deep/cache", "/tmp/mago-workspace-abcd"]),
  );
  expect(
    candidates.filter((entry) => !held.has(entry.path)).map((entry) => entry.name),
  ).not.toContain("jest_501");
  expect(
    candidates.filter((entry) => !held.has(entry.path)).map((entry) => entry.name),
  ).not.toContain("mago-workspace-abcd");
});

test("a recent nested cache file or nested service lease protects an otherwise old tool cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-tool-cache-"));
  const nested = join(root, "deep/nested");
  const content = join(nested, "cache");
  const old = new Date(now - 2 * DAY);
  const ageDirectories = async () => {
    for (const dir of [nested, join(root, "deep"), root]) await utimes(dir, old, old);
  };
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(content, "cache");
    await utimes(content, old, old);
    await writeFile(join(nested, "composer.lock"), "dependency versions");
    await utimes(join(nested, "composer.lock"), old, old);
    await ageDirectories();
    expect(await toolCacheIdle(root, now, 1)).toBe(true);
    await utimes(content, new Date(now - DAY + 1), new Date(now - DAY + 1));
    expect(await toolCacheIdle(root, now, 1)).toBe(false);
    await utimes(content, old, old);
    await writeFile(join(nested, "service.lock"), "lease holder");
    await utimes(join(nested, "service.lock"), old, old);
    await ageDirectories();
    expect(await toolCacheIdle(root, now, 1)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("cleanup candidates include ignored builds and packages, never folders containing tracked files", () => {
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
    "tracked/vendor/",
  ];

  const { outputs, dependencyDirs } = nativeBuildCandidates(
    ignored,
    MAC_WATCHER.storage.nativeBuilds,
    ["tracked/vendor/keep.php"],
  );

  expect(outputs).toEqual([
    "harium-app/.expo/",
    "harium-app/android/",
    "harium-app/ios/",
    "harium-app/modules/focus-activity/android/build/",
    "harium-app/modules/widgets/ios/Pods/",
    "harium/public/build/",
  ]);
  expect(dependencyDirs).toEqual(["harium-app/node_modules/", "harium/vendor/", "node_modules/"]);
});

test("kept dirty or open-PR checkouts clear packages only after every file has been idle for 24 hours", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-prune-test-"));
  const git = async (...args: string[]) => {
    const result = await Bun.$`git -C ${root} ${args}`.quiet();
    expect(result.exitCode).toBe(0);
  };
  const time = Date.now();
  const old = new Date(time - DAY - 1000);

  try {
    await git("init", "--quiet");
    await writeFile(join(root, ".gitignore"), "node_modules/\nvendor/\ndist/\n");
    for (const folder of ["node_modules", "vendor", "dist"]) await mkdir(join(root, folder));
    await writeFile(join(root, "node_modules/installed.js"), "installed");
    await writeFile(join(root, "vendor/keep.php"), "tracked");
    await writeFile(join(root, "vendor/installed.php"), "installed");
    await writeFile(join(root, "source.ts"), "original");
    await git("add", ".gitignore", "source.ts");
    await git("add", "--force", "vendor/keep.php");
    await writeFile(join(root, "source.ts"), "uncommitted work");
    for (const path of await readdir(root, { recursive: true }))
      await utimes(join(root, path), old, old);
    await utimes(root, old, old);

    expect((await idleNativeBuilds(root, time)).sort()).toEqual(
      [join(root, "node_modules"), join(root, "dist")].sort(),
    );
    await utimes(join(root, "source.ts"), new Date(time - DAY + 1000), new Date(time - DAY + 1000));
    expect(await idleNativeBuilds(root, time)).toEqual([]);
    await utimes(join(root, "source.ts"), old, old);
    await utimes(join(root, "node_modules/installed.js"), new Date(time), new Date(time));
    expect(await idleNativeBuilds(root, time)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    inUse: false,
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
    idleDays: 3,
    prefixes: ["awraq_", "harium_"],
    checkoutExists: (path) => path.endsWith("/live"),
  });

  expect(dropped.map((database) => database.name)).toEqual([
    "harium_gone_1a2b3c4d_testing",
    "harium_gone_1a2b3c4d_testing_test_1",
    "harium_live_5e6f7a8b_testing",
    "awraq_old_testing",
    "awraq_old_testing_test_2",
  ]);
});

test("idle test databases and parallel workers go even while their checkout exists", () => {
  const databases = ["harium_live_testing", "harium_live_testing_test_1"].map((name) => ({
    name,
    checkouts: ["/repo/live"],
    touchedMs: now - 4 * DAY,
    bytes: 1,
    inUse: false,
  }));

  expect(
    testDatabasesToDrop(databases, {
      now,
      idleDays: 3,
      prefixes: ["harium_"],
      checkoutExists: () => true,
    }),
  ).toEqual(databases);
});

test("test database pruning protects busy families, recent activity, unknown ages, and non-test names", () => {
  const db = (name: string, touchedMs = now - 3 * DAY, inUse = false): TestDatabaseFacts => ({
    name,
    touchedMs,
    inUse,
    checkouts: ["/repo/live"],
    bytes: 1,
  });
  const databases = [
    db("app_boundary_testing"),
    db("app_recent_testing", now - 3 * DAY + 1),
    db("app_reading_testing"),
    db("app_reading_testing_test_1", now - 4 * DAY, true),
    db("app_writing_testing"),
    db("app_writing_testing_test_2", now - DAY),
    db("app_unknown_testing", now),
    { ...db("app_gone_testing", now - 10 * DAY, true), checkouts: ["/gone"] },
    { ...db("app_production", now - 30 * DAY), checkouts: ["/gone"] },
    db("unsafe`_testing"),
    db("testing"),
    db("books_testing"),
    db("books_marked_testing"),
  ];

  expect(
    testDatabasesToDrop(databases, {
      now,
      idleDays: 3,
      prefixes: ["app_"],
      checkoutExists: (path) => path === "/repo/live",
    }).map((database) => database.name),
  ).toEqual(["app_boundary_testing"]);
});

test("test runners protect databases even between MySQL connections", () => {
  for (const command of [
    "php artisan test --parallel",
    "php /repo/vendor/bin/pest --parallel",
    "php vendor/bin/phpunit",
    "/repo/vendor/bin/paratest",
    "bun scripts/backend-test.ts",
    "bun scripts/test-runtime.ts -- php artisan test",
  ])
    expect(testRunInProgress(command)).toBe(true);

  expect(
    testRunInProgress(
      "/usr/local/bin/mysqld\nphp artisan serve\nbun test src/lib/storage-prune.test.ts",
    ),
  ).toBe(false);
});

test("a running suite protects its checkout and unmarked databases, allowing unrelated checkouts to expire", () => {
  const database: TestDatabaseFacts = {
    name: "app_testing",
    checkouts: ["/repo/live"],
    touchedMs: now - 4 * DAY,
    bytes: 1,
    inUse: false,
  };
  expect(testDatabaseRunInProgress([database], new Set(["/repo/live/backend"]))).toBe(true);
  expect(testDatabaseRunInProgress([database], new Set(["/repo"]))).toBe(true);
  expect(testDatabaseRunInProgress([database], new Set(["/repo/other"]))).toBe(false);
  expect(testDatabaseRunInProgress([database], undefined)).toBe(true);
  expect(
    testDatabaseRunInProgress([{ ...database, checkouts: [] }], new Set(["/repo/other"])),
  ).toBe(true);
  expect(testDatabaseRunInProgress([{ ...database, checkouts: [] }], new Set())).toBe(false);
});

test("a build folder goes after the age limit, or after an idle hour once its project is gone", () => {
  const HOUR = 60 * 60 * 1000;
  const folder = (name: string, idle: number, projectGone: boolean) => ({
    path: `/dd/${name}`,
    mtimeMs: now - idle,
    projectGone,
  });
  const children = [
    folder("old", 15 * DAY, false),
    folder("live", 2 * DAY, false),
    folder("gone", 2 * HOUR, true),
    folder("gone-busy", 30 * 60 * 1000, true),
  ];

  expect(
    staleChildren(children, { days: 14, projectGoneHours: 1, now }).map((child) => child.path),
  ).toEqual(["/dd/old", "/dd/gone"]);
  expect(staleChildren(children, { days: 14, now }).map((child) => child.path)).toEqual([
    "/dd/old",
  ]);
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
