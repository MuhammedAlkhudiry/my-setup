import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import type { ActiveProject } from "../../config/active-projects";
import {
  cleanupWorktrees,
  cleanupCachePath,
  cleanupDoctorHint,
  parseCleanupOpenFiles,
  parseCleanupWorktrees,
  readCleanupThreads,
  WORKTREE_SIZE_WARNING_BYTES,
  WORKTREE_CLEANUP_GRACE_MS,
  type CleanupPr,
  type CleanupServices,
  type CleanupThread,
} from "./worktree-cleanup";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporary() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "worktree-cleanup-test-")));
  directories.push(directory);

  return directory;
}

function git(root: string, ...args: string[]): string {
  return execaSync("git", ["-C", root, ...args], {
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  }).stdout.trim();
}

function fixture() {
  const directory = temporary();
  const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const root = join(directory, "repo");
  const remote = join(directory, "remote.git");
  mkdirSync(root);
  execaSync("git", ["init", "-b", "main", root]);
  execaSync("git", ["init", "--bare", remote]);
  git(root, "config", "user.name", "Cleanup test");
  git(root, "config", "user.email", "cleanup@example.invalid");
  writeFileSync(join(root, "file"), "base\n");
  git(root, "add", "file");
  git(root, "commit", "-m", "base");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const project: ActiveProject = {
    id: "test",
    name: "Test",
    remoteUrl: remote,
    baseBranch: "main",
    canonicalRoot: root,
  };
  const prs: CleanupPr[] = [];
  const threads: CleanupThread[] = [];
  const files = new Map<string, Set<number>>();
  const services: CleanupServices = {
    async readPrs() {
      return prs;
    },
    async readThreads() {
      return threads;
    },
    async readOpenFiles() {
      return files;
    },
  };
  writeFileSync(join(root, ".git/info/exclude"), ".worktrees/\n");
  const tree = (branch: string, detached = false, path = join(root, ".worktrees", branch)) => {
    git(root, "worktree", "add", ...(detached ? ["--detach"] : ["-b", branch]), path, "main");

    return path;
  };

  const finish = (branch: string) => {
    const head = git(root, "rev-parse", branch);
    const number = prs.length + 1;
    git(root, "push", "origin", `${branch}:refs/pull/${number}/head`);
    prs.push({ number, state: "CLOSED", branch, head, updatedAt: "2026-10-13" });
  };

  return { directory, now, root, remote, project, prs, threads, files, services, tree, finish };
}

async function evaluate(
  f: ReturnType<typeof fixture>,
  options: {
    apply?: boolean;
    home?: string;
    projects?: ActiveProject[];
    services?: CleanupServices;
  } = {},
) {
  const base = {
    home: options.home ?? f.directory,
    now: f.now,
    projects: [f.project],
    services: f.services,
  };
  const dry = await cleanupWorktrees(base);

  if (!options.apply) return dry;

  const applied = await cleanupWorktrees({ ...base, apply: dry.plan!.path });
  const key = (entry: { kind: string; path: string | null; branch: string | null }) =>
    JSON.stringify([entry.kind, entry.path, entry.branch]);

  return {
    ...applied,
    entries: [
      ...applied.entries,
      ...dry.entries.filter(
        (entry) => !applied.entries.some((result) => key(result) === key(entry)),
      ),
    ],
  };
}

describe("worktree cleanup safety", () => {
  test("apply only consumes its saved plan, even when another PR finishes after review", async () => {
    const f = fixture();
    const planned = f.tree("reviewed");
    f.finish("reviewed");
    const options = { home: f.directory, now: f.now, projects: [f.project], services: f.services };
    const dry = await cleanupWorktrees(options);
    expect(dry.errors).toEqual([]);
    const saved = JSON.parse(readFileSync(dry.plan!.path, "utf8"));
    expect(saved.id).toBe(dry.plan!.id);
    expect(saved.entries).toHaveLength(2);
    const newWork = f.tree("newly-merged");
    f.finish("newly-merged");

    const applied = await cleanupWorktrees({ ...options, apply: dry.plan!.id });
    expect(applied.errors).toEqual([]);
    expect(applied.summary.removedWorktrees).toBe(1);
    expect(applied.summary.removedBranches).toBe(1);
    expect(existsSync(planned)).toBe(false);
    expect(existsSync(newWork)).toBe(true);
    expect(applied.entries.some((entry) => entry.branch === "newly-merged")).toBe(false);
    expect(git(f.root, "rev-parse", "newly-merged")).toBe(git(f.root, "rev-parse", "main"));
  });

  test("an already-deleted planned branch is already done, without a Git ambiguity error", async () => {
    const f = fixture();
    git(f.root, "branch", "gone", "main");
    f.finish("gone");
    const options = { home: f.directory, now: f.now, projects: [f.project], services: f.services };
    const dry = await cleanupWorktrees(options);
    git(f.root, "branch", "-D", "gone");

    const applied = await cleanupWorktrees({ ...options, apply: dry.plan!.path });
    expect(applied.errors).toEqual([]);
    expect(applied.entries).toHaveLength(1);
    expect(applied.entries[0]).toMatchObject({ branch: "gone", alreadyDone: true, removed: false });
    expect(applied.entries[0].reasons.join(" ")).toContain("already done");
  });

  test.each(["PR", "commit", "files"] as const)(
    "a recent %s keeps otherwise finished work through the four-hour grace period",
    async (activity) => {
      const f = fixture();
      const path = f.tree("recent");
      const recent = new Date(f.now - WORKTREE_CLEANUP_GRACE_MS / 2);
      if (activity === "commit") {
        execaSync("git", ["-C", path, "commit", "--allow-empty", "-m", "recent work"], {
          env: { GIT_AUTHOR_DATE: recent.toISOString(), GIT_COMMITTER_DATE: recent.toISOString() },
        });
      }
      f.finish("recent");
      if (activity === "PR") f.prs[0].finishedAt = recent.toISOString();
      if (activity === "files") utimesSync(join(path, "file"), recent, recent);

      const report = await evaluate(f);
      const entry = report.entries.find((entry) => entry.path === path)!;
      expect(report.errors).toEqual([]);
      expect(entry.decision).toBe("keep");
      expect(entry.reasons.join(" ")).toContain("four-hour grace period");
      expect(
        JSON.parse(readFileSync(report.plan!.path, "utf8")).entries.some(
          (item: { path: string }) => item.path === path,
        ),
      ).toBe(false);
    },
  );

  test.each(["recent", "running", "cwd"] as const)(
    "apply rechecks extra worktrees protected by a %s session, without a direct binding",
    async (activity) => {
      const f = fixture();
      const path = f.tree("extra-worktree");
      f.finish("extra-worktree");
      const options = {
        home: f.directory,
        now: f.now,
        projects: [f.project],
        services: f.services,
      };
      const dry = await cleanupWorktrees(options);
      if (activity === "cwd") f.files.set(path, new Set([567]));
      else
        f.threads.push({
          title: "Expand Basic Character Wardrobe",
          projectRoot: f.root,
          branch: "other-branch",
          worktreePath: join(f.root, ".worktrees/other"),
          ...(activity === "running"
            ? { running: true }
            : { lastActivityAt: new Date(f.now - 1000).toISOString() }),
        });

      const applied = await cleanupWorktrees({ ...options, apply: dry.plan!.path });
      expect(applied.errors).toEqual([]);
      expect(applied.summary.removedWorktrees).toBe(0);
      expect(applied.summary.removedBranches).toBe(0);
      const entry = applied.entries.find((entry) => entry.path === path)!;
      expect(entry.decision).toBe("keep");
      expect(entry.reasons.join(" ")).toContain(
        activity === "cwd" ? "files open by process" : "recently active or running T3 project",
      );
      expect(existsSync(path)).toBe(true);
    },
  );

  test("a detached head stays even when a finished PR otherwise identifies it", async () => {
    const f = fixture();
    const path = f.tree("detached-finished", true);
    f.prs.push({
      number: 1,
      state: "MERGED",
      branch: "main",
      head: git(path, "rev-parse", "HEAD"),
      updatedAt: "2026-01-01",
    });

    const report = await evaluate(f);
    const entry = report.entries.find((entry) => entry.path === path)!;
    expect(entry.reasons).toContain("detached-head worktrees are never removed");
    expect(entry.decision).toBe("keep");
    expect(existsSync(path)).toBe(true);
  });

  test.each([false, true])(
    "keeps fresh main-based worktrees and branches without a PR (apply=%s)",
    async (apply) => {
      const f = fixture();
      const path = f.tree("fresh");
      git(f.root, "branch", "fresh-unbound", "main");

      const report = await evaluate(f, { apply, projects: [f.project], services: f.services });
      const entries = report.entries.filter((entry) => entry.branch?.startsWith("fresh"));
      expect(report.errors).toEqual([]);
      expect(entries).toHaveLength(3);
      expect(
        entries.every(
          (entry) =>
            entry.inDefaultBranch &&
            entry.decision === "keep" &&
            entry.reasons.some((reason) => reason.includes("no finished PR")),
        ),
      ).toBe(true);
      expect(report.summary.removedWorktrees).toBe(0);
      expect(report.summary.removedBranches).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(git(f.root, "rev-parse", "fresh-unbound")).toBe(git(f.root, "rev-parse", "main"));
    },
  );

  test.each(["worktreePath", "projectRoot"] as const)(
    "keeps a finished PR worktree bound through an aliased thread %s",
    async (binding) => {
      const f = fixture();
      const path = f.tree("bound");
      f.finish("bound");
      const alias = join(f.directory, "worktree-alias");
      symlinkSync(path, alias);
      const aliasedPath = alias.replace(/^\/private(?=\/)/, "");
      f.threads.push({
        title: "Idle family-book workshop",
        projectRoot: binding === "projectRoot" ? aliasedPath : f.root,
        worktreePath: binding === "worktreePath" ? aliasedPath : null,
        branch: null,
      });

      const report = await evaluate(f, {
        apply: true,
        projects: [f.project],
        services: f.services,
      });
      const entry = report.entries.find((item) => item.path === path)!;
      expect(report.errors).toEqual([]);
      expect(entry.activeThreads).toEqual(["Idle family-book workshop"]);
      expect(entry.decision).toBe("keep");
      expect(report.summary.removedWorktrees).toBe(0);
      expect(report.summary.removedBranches).toBe(0);
      expect(existsSync(path)).toBe(true);
    },
  );

  test("only removes finished worktrees under T3 or project roots; keeps temporary and symlink-escaped worktrees", async () => {
    const f = fixture();
    const home = join(f.directory, "home");
    const managed = f.tree("managed", false, join(home, ".t3/worktrees/project/managed"));
    f.finish("managed");
    const external = f.tree("temporary", false, join(f.directory, "i18n-selector-work/baseline"));
    f.finish("temporary");
    const outside = join(f.directory, "external");
    mkdirSync(outside);
    const alias = join(f.root, ".worktrees/escape");
    mkdirSync(join(f.root, ".worktrees"), { recursive: true });
    symlinkSync(outside, alias);
    f.tree("escaped", false, join(alias, "tree"));
    f.finish("escaped");

    const report = await evaluate(f, {
      apply: true,
      home,
      projects: [f.project],
      services: f.services,
    });
    expect(report.errors).toEqual([]);
    expect(existsSync(managed)).toBe(false);
    for (const branch of ["temporary", "escaped"]) {
      const entry = report.entries.find(
        (item) => item.kind === "worktree" && item.branch === branch,
      )!;
      expect(entry.decision).toBe("keep");
      expect(entry.reasons.join(" ")).toContain(
        "outside the T3 worktree directory and project root",
      );
      expect(existsSync(entry.path!)).toBe(true);
      expect(git(f.root, "rev-parse", branch)).toBe(git(f.root, "rev-parse", "main"));
    }
    expect(existsSync(external)).toBe(true);
    expect(report.summary.removedWorktrees).toBe(1);
    expect(report.summary.removedBranches).toBe(1);
  });

  test("dry run handles squash/closed PRs and preserves every protected worktree and branch", async () => {
    const f = fixture();
    const squash = f.tree("squash");
    writeFileSync(join(squash, "feature"), "squashed\n");
    git(squash, "add", "feature");
    git(squash, "commit", "-m", "feature");
    const squashHead = git(squash, "rev-parse", "HEAD");
    git(f.root, "push", "origin", "squash:refs/pull/1/head");
    git(f.root, "merge", "--squash", "squash");
    git(f.root, "commit", "-m", "squash merge");
    git(f.root, "push", "origin", "main");
    f.prs.push({
      number: 1,
      state: "MERGED",
      branch: "squash",
      head: squashHead,
      updatedAt: "2026-10-13",
    });
    const closed = f.tree("closed");
    writeFileSync(join(closed, "abandoned"), "published\n");
    git(closed, "add", "abandoned");
    git(closed, "commit", "-m", "closed proposal");
    const closedHead = git(closed, "rev-parse", "HEAD");
    git(f.root, "push", "origin", "closed:refs/pull/2/head");
    f.prs.push({
      number: 2,
      state: "CLOSED",
      branch: "closed",
      head: closedHead,
      updatedAt: "2026-10-13",
    });

    const dirty = f.tree("dirty");
    writeFileSync(join(dirty, "file"), "uncommitted\n");
    const untracked = f.tree("untracked");
    writeFileSync(join(untracked, "draft"), "keep\n");
    const busy = f.tree("busy");
    f.files.set(join(busy, "file"), new Set([123]));
    f.tree("active");
    f.threads.push({
      title: "Ongoing release",
      projectRoot: f.root,
      worktreePath: null,
      branch: "active",
    });
    const locked = f.tree("locked");
    git(f.root, "worktree", "lock", locked);
    f.tree("detached", true);
    const unpublished = f.tree("unpublished");
    writeFileSync(join(unpublished, "local"), "unpublished\n");
    git(unpublished, "add", "local");
    git(unpublished, "commit", "-m", "local only");
    f.prs.push({ ...f.prs[0], branch: "unpublished" });
    const open = f.tree("open");
    f.prs.push({
      number: 3,
      state: "OPEN",
      branch: "open",
      head: git(open, "rev-parse", "HEAD"),
      updatedAt: "2026-10-13",
    });
    git(f.root, "branch", "standalone", "main");
    const beforeRefs = git(f.root, "show-ref");
    const beforeTrees = git(f.root, "worktree", "list", "--porcelain");

    const report = await evaluate(f, { projects: [f.project], services: f.services });
    const entry = (kind: string, branch: string | null) =>
      report.entries.find((item) => item.kind === kind && item.branch === branch)!;
    expect(report.errors).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(entry("worktree", "squash")).toMatchObject({
      decision: "remove",
      inDefaultBranch: false,
      unpushedCommits: 0,
    });
    expect(entry("worktree", "closed").decision).toBe("remove");
    expect(entry("worktree", null).decision).toBe("keep");
    expect(entry("branch", "standalone").decision).toBe("keep");
    for (const branch of [
      "main",
      "dirty",
      "untracked",
      "busy",
      "active",
      "locked",
      "unpublished",
      "open",
    ]) {
      expect(entry("worktree", branch).decision).toBe("keep");
      expect(entry("branch", branch).decision).toBe("keep");
    }
    expect(entry("worktree", "unpublished").unpushedCommits).toBe(1);
    expect(entry("worktree", "unpublished").reasons.join(" ")).toContain(
      "differs from the finished PR head",
    );
    expect(report.summary.removableBytes).toBeGreaterThan(0);
    expect(report.summary.reclaimedBytes).toBe(0);
    expect(git(f.root, "show-ref")).toBe(beforeRefs);
    expect(git(f.root, "worktree", "list", "--porcelain")).toBe(beforeTrees);
  });

  test("apply removes finished work, preserves kept worktree branches, and reports reclaimed bytes", async () => {
    const f = fixture();
    const finished = f.tree("finished");
    f.finish("finished");
    const dirty = f.tree("dirty");
    writeFileSync(join(dirty, "untracked"), "keep\n");
    git(f.root, "branch", "standalone", "main");
    f.finish("standalone");

    const report = await evaluate(f, {
      apply: true,
      projects: [f.project],
      services: f.services,
    });
    expect(report.errors).toEqual([]);
    expect(report.summary).toMatchObject({ removedWorktrees: 1, removedBranches: 2 });
    expect(report.summary.reclaimedBytes).toBeGreaterThan(0);
    expect(existsSync(finished)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    expect(git(f.root, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual([
      "dirty",
      "main",
    ]);
    expect(existsSync(join(f.root, ".git/worktree-cleanup.lock"))).toBe(false);
  });

  test("apply rechecks status and compare-deletes branch heads", async () => {
    const f = fixture();
    const changed = f.tree("changed");
    f.finish("changed");
    git(f.root, "branch", "racing", "main");
    f.finish("racing");
    let reads = 0;
    f.services.readThreads = async () => {
      if (++reads === 2) writeFileSync(join(changed, "new-draft"), "arrived after inspection\n");

      return f.threads;
    };
    let prReads = 0;
    f.services.readPrs = async () => {
      if (++prReads === 3) {
        const parent = git(f.root, "rev-parse", "main");
        const tree = git(f.root, "rev-parse", "main^{tree}");
        const head = execaSync("git", [
          "-C",
          f.root,
          "commit-tree",
          tree,
          "-p",
          parent,
          "-m",
          "concurrent commit",
        ]).stdout.trim();
        git(f.root, "update-ref", "refs/heads/racing", head);
      }

      return f.prs;
    };

    const report = await evaluate(f, {
      apply: true,
      projects: [f.project],
      services: f.services,
    });
    expect(existsSync(changed)).toBe(true);
    expect(git(f.root, "rev-parse", "racing")).not.toBe(git(f.root, "rev-parse", "main"));
    expect(report.summary.removedWorktrees).toBe(0);
    expect(report.summary.removedBranches).toBe(0);
    expect(report.errors.join(" ")).toContain("cannot lock ref");
    expect(report.entries.find((entry) => entry.path === changed)?.reasons.join(" ")).toContain(
      "untracked",
    );
  });

  test.each(["thread", "process"])(
    "apply keeps a worktree claimed by a %s after inspection",
    async (guard) => {
      const f = fixture();
      const path = f.tree("claimed");
      f.finish("claimed");
      let reads = 0;
      f.services.readThreads = async () => {
        if (++reads === 2) {
          if (guard === "thread")
            f.threads.push({
              title: "Resumed task",
              projectRoot: f.root,
              branch: "claimed",
              worktreePath: path,
            });
          else f.files.set(path, new Set([321]));
        }

        return f.threads;
      };

      const report = await evaluate(f, {
        apply: true,
        projects: [f.project],
        services: f.services,
      });
      expect(report.errors).toEqual([]);
      expect(report.summary.removedWorktrees).toBe(0);
      expect(report.summary.removedBranches).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(git(f.root, "rev-parse", "claimed")).toBe(git(f.root, "rev-parse", "main"));
    },
  );

  test("keeps all work when the remote default branch differs from configuration", async () => {
    const f = fixture();
    const path = f.tree("finished");
    git(f.remote, "update-ref", "refs/heads/new-default", git(f.root, "rev-parse", "main"));
    git(f.remote, "symbolic-ref", "HEAD", "refs/heads/new-default");

    const report = await evaluate(f, {
      apply: true,
      projects: [f.project],
      services: f.services,
    });
    expect(report.errors.join(" ")).toContain("default branch differs");
    expect(report.entries.every((entry) => entry.decision === "keep")).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test.each(["readThreads", "readOpenFiles", "readPrs"] as const)(
    "fails closed when %s is unavailable",
    async (boundary) => {
      const f = fixture();
      const tree = f.tree("finished");
      f.services[boundary] = async () => {
        throw new Error("unavailable");
      };

      const report = await evaluate(f, {
        apply: true,
        projects: [f.project],
        services: f.services,
      });
      expect(report.errors.join(" ")).toContain("unavailable");
      expect(report.entries.every((entry) => entry.decision === "keep")).toBe(true);
      expect(existsSync(tree)).toBe(true);
      expect(git(f.root, "rev-parse", "finished")).toBe(git(f.root, "rev-parse", "main"));
    },
  );
});

test("T3 reads a WAL-aware temporary snapshot and protects unsettled, snoozed, live and launching threads", async () => {
  const home = temporary();
  const directory = join(home, ".t3/userdata");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "statev2.sqlite");
  const db = new Database(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT, status TEXT, active_turn_id TEXT);
    CREATE TABLE provider_session_runtime (thread_id TEXT, status TEXT);
    CREATE TABLE projection_threads (thread_id TEXT, project_id TEXT, title TEXT, worktree_path TEXT, branch TEXT, archived_at TEXT, deleted_at TEXT, settled_at TEXT, settled_override TEXT, unsettled_at TEXT);
    CREATE TABLE orchestration_v2_thread_launch_workflows (title TEXT, project_id TEXT, worktree_path TEXT, branch TEXT, status TEXT);
    INSERT INTO projection_projects VALUES ('project', '/canonical');
  `);
  const insert = db.query(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?, 'project', ?)",
  );
  const add = (title: string, fields: Record<string, unknown> = {}) =>
    insert.run(
      title,
      JSON.stringify({
        title,
        branch: title,
        worktreePath: `/trees/${title}`,
        settledOverride: null,
        settledAt: null,
        archivedAt: null,
        deletedAt: null,
        ...fields,
      }),
    );
  add("idle");
  add("snoozed", { snoozedUntil: "2999-01-01" });
  add("settled", { settledOverride: "settled", settledAt: "2026-10-12" });
  add("unsettled-again", { settledAt: "2026-10-12", unsettledAt: "2026-10-13" });
  add("idle-session", { archivedAt: "2026-10-12", settledOverride: "settled" });
  add("idle-runtime", { archivedAt: "2026-10-12", settledOverride: "settled" });
  add("stopped-session", { archivedAt: "2026-10-12", settledOverride: "settled" });
  add("ready-session", { updatedAt: "2026-01-01T00:00:00Z" });
  add("live", { archivedAt: "2026-10-12", settledOverride: "settled" });
  add("archived", { archivedAt: "2026-10-12" });
  add("deleted", { deletedAt: "2026-10-12" });
  db.exec(`
    INSERT INTO orchestration_v2_projection_runs (thread_id, status) VALUES ('live', 'running');
    INSERT INTO projection_thread_sessions VALUES ('idle-session', 'idle', NULL);
    INSERT INTO provider_session_runtime VALUES ('idle-runtime', 'idle');
    INSERT INTO projection_thread_sessions VALUES ('stopped-session', 'stopped', 'old-turn');
    INSERT INTO projection_thread_sessions VALUES ('ready-session', 'ready', NULL);
    INSERT INTO projection_threads VALUES ('legacy', 'project', 'Legacy work', '/trees/legacy', 'legacy', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO orchestration_v2_thread_launch_workflows VALUES ('Launching work', 'project', '/trees/launching', 'launching', 'preparing');
  `);
  const before = readFileSync(path);
  const wal = readFileSync(`${path}-wal`);
  try {
    const threads = await readCleanupThreads(home);
    expect(threads.map((thread) => thread.title).sort()).toEqual([
      "Launching work",
      "Legacy work",
      "idle",
      "idle-runtime",
      "idle-session",
      "live",
      "ready-session",
      "settled",
      "snoozed",
      "unsettled-again",
    ]);
    expect(threads.find((thread) => thread.title === "ready-session")?.running).toBe(false);
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(`${path}-wal`)).toEqual(wal);
    insert.run("unknown", JSON.stringify({ title: "Unknown binding" }));
    await expect(readCleanupThreads(home)).rejects.toThrow();
  } finally {
    db.close();
  }
});

test("NUL-delimited paths preserve whitespace, locked flags and open-file process identities", () => {
  const path = "/does-not-exist/work tree\nwith newline";
  const head = "a".repeat(40);
  const [tree] = parseCleanupWorktrees(
    `worktree ${path}\0HEAD ${head}\0branch refs/heads/task\0locked owner\0\0`,
  );
  expect(tree).toMatchObject({ path, head, branch: "task", locked: true });
  const files = parseCleanupOpenFiles(`p123\0\nn${path}/file\0n${path}/file\0\np456\0\nn${path}\0`);
  expect([...files.get(`${path}/file`)!]).toEqual([123]);
  expect([...files.get(path)!]).toEqual([456]);
  const directory = temporary();
  const alias = join(directory, "alias");
  symlinkSync(directory, alias);
  const deleted = parseCleanupOpenFiles(`p789\0\nn${alias}/deleted-file\0`);
  expect([...deleted.get(join(directory, "deleted-file"))!]).toEqual([789]);
});

test("doctor uses recent cached sizes and falls back to counts for old, missing or corrupt reports", async () => {
  const home = temporary();
  const now = Date.parse("2026-10-13T12:00:00Z");
  expect(await cleanupDoctorHint(home, 0, now)).toBeNull();
  expect(await cleanupDoctorHint(home, 6, now)).toContain("6 registered T3 worktrees");
  const path = cleanupCachePath(home);
  mkdirSync(join(home, ".local/state/my-setup"), { recursive: true });
  const cache = {
    completedAt: new Date(now).toISOString(),
    t3Worktrees: 6,
    t3Bytes: 32 * 1024 ** 3,
    unmeasuredWorktrees: 0,
    errors: 0,
  };
  writeFileSync(path, JSON.stringify(cache));

  expect(await cleanupDoctorHint(home, 6, now)).toContain("32.0 GiB");
  expect(await cleanupDoctorHint(home, 6, now + 25 * 60 * 60 * 1000)).toContain("stale");
  writeFileSync(path, JSON.stringify({ ...cache, t3Bytes: WORKTREE_SIZE_WARNING_BYTES - 1 }));
  expect(await cleanupDoctorHint(home, 6, now)).toBeNull();
  writeFileSync(path, "invalid JSON");
  expect(await cleanupDoctorHint(home, 6, now)).toContain("no recent size report");
  writeFileSync(path, "x".repeat(4097));
  expect(await cleanupDoctorHint(home, 6, now)).toContain("no recent size report");
});
