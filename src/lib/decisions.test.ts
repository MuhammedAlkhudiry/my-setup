import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import type { ActiveProject } from "../../config/active-projects";
import {
  DecisionIndex,
  formatResults,
  parseResults,
  reasonFromSnippet,
  repositoryKey,
  resolveCheckout,
  structuredQuery,
  type QmdRunner,
} from "./decisions";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "decisions-test-")));
  directories.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function repository(remote = "git@github.com:Owner/Harium-Project.git"): string {
  const root = tempDir();
  mkdirSync(join(root, "docs", "decisions", "ai"), { recursive: true });
  writeFileSync(
    join(root, "docs", "decisions", "ai", "owner-notices.md"),
    "The companion notifies the owner.\n",
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", remote);
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  return root;
}

function projects(canonicalRoot = "/nowhere/harium-project"): ActiveProject[] {
  return [
    {
      id: "harium",
      name: "Harium",
      remoteUrl: "https://github.com/owner/harium-project.git",
      baseBranch: "main",
      canonicalRoot,
    },
  ];
}

// Records qmd calls and mimics the config file collection add writes.
function fakeQmd(stdout = "[]"): { calls: string[][]; run: QmdRunner } {
  const calls: string[][] = [];
  const run: QmdRunner = async (args, env) => {
    calls.push(args);
    if (args[0] === "collection" && args[1] === "add") {
      mkdirSync(env.QMD_CONFIG_DIR, { recursive: true });
      writeFileSync(
        join(env.QMD_CONFIG_DIR, "index.yml"),
        `collections:\n  ${args[4]}:\n    path: ${args[2]}\n`,
      );
    }
    return { exitCode: 0, stdout: args[0] === "query" ? stdout : "", stderr: "" };
  };
  return { calls, run };
}

test("remotes match across protocols, users, suffixes, and case", () => {
  expect(repositoryKey("git@github.com:Owner/Repo.git")).toBe("github.com/owner/repo");
  expect(repositoryKey("https://token@github.com/owner/repo")).toBe("github.com/owner/repo");
  expect(repositoryKey("ssh://git@github.com/owner/repo.git")).toBe("github.com/owner/repo");
});

test("the checkout comes from the cwd's git root, including worktrees and subdirectories", async () => {
  const root = repository();
  expect(await resolveCheckout(join(root, "docs"), undefined, projects())).toEqual({
    project: "harium",
    root,
  });

  const worktree = join(tempDir(), "task");
  git(root, "worktree", "add", "-q", "-b", "task", worktree);
  git(worktree, "remote", "remove", "origin");
  // Without a remote, the shared .git still ties the worktree to its canonical clone.
  expect(await resolveCheckout(worktree, undefined, projects(root))).toEqual({
    project: "harium",
    root: worktree,
  });
});

test("--project picks the canonical clone outside its checkouts and rejects unknown projects", async () => {
  const elsewhere = tempDir();
  expect(await resolveCheckout(elsewhere, "harium", projects())).toEqual({
    project: "harium",
    root: "/nowhere/harium-project",
  });
  await expect(resolveCheckout(elsewhere, "nope", projects())).rejects.toThrow(
    "unknown project nope",
  );
  await expect(resolveCheckout(elsewhere, undefined, projects())).rejects.toThrow(
    "--project harium",
  );
});

test("the index builds once, skips unchanged decisions, updates changed ones, and prunes gone checkouts", async () => {
  const root = repository();
  const state = tempDir();
  const qmd = fakeQmd();
  const index = new DecisionIndex({ project: "harium", root }, state, qmd.run);

  expect(await index.ensureFresh()).toBe(true);
  expect(qmd.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
    "collection add",
    "embed -c",
  ]);
  expect(qmd.calls[0]).toContain("**/*.md");
  expect(index.env.INDEX_PATH).toBe(join(state, "harium", "index.sqlite"));

  qmd.calls.length = 0;
  expect(await index.ensureFresh()).toBe(false);
  expect(qmd.calls).toEqual([]);

  const gone = join(state, "harium", "collections", "harium-gone.json");
  writeFileSync(gone, JSON.stringify({ root: "/nowhere", fingerprint: "x" }));
  const file = join(root, "docs", "decisions", "ai", "owner-notices.md");
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  expect(await index.ensureFresh()).toBe(true);
  expect(qmd.calls.map((args) => args[0])).toEqual(["update", "embed"]);
  expect(existsSync(gone)).toBe(false);
});

test("queries are structured, and results become paths, titles, and one-line reasons", async () => {
  expect(structuredQuery('ping the "founder\nnow', "notify owner")).toBe(
    "intent: Recorded product decisions that govern or rule out this change\nlex: notify owner\nvec: ping the founder now",
  );
  expect(structuredQuery("ping the founder")).not.toContain("lex:");
  expect(() => structuredQuery("  ")).toThrow();

  const root = "/repo";
  const rows = [
    {
      file: "qmd://harium-abc/ai/owner-notices.md",
      score: 0.83,
      snippet: "@@ -1,3 @@ (0 before)\nThe companion\nnotifies...",
    },
    { file: "qmd://other/ai/x.md", score: 0.5, snippet: "elsewhere" },
  ];
  const decisions = parseResults(
    JSON.stringify(rows),
    "harium-abc",
    join(root, "docs", "decisions"),
  );
  expect(decisions).toEqual([
    {
      path: join(root, "docs", "decisions", "ai", "owner-notices.md"),
      title: "Owner notices",
      reason: "The companion notifies",
      score: 0.83,
    },
  ]);
  expect(formatResults(decisions, root, root)).toBe(
    "docs/decisions/ai/owner-notices.md [0.83] Owner notices: The companion notifies",
  );
  expect(formatResults(decisions, "/elsewhere", root)).toStartWith(
    "/repo/docs/decisions/ai/owner-notices.md",
  );

  const reason = reasonFromSnippet(`${"word ".repeat(60)}end`);
  expect(reason.length).toBeLessThanOrEqual(161);
  expect(reason).toEndWith("word…");
});
