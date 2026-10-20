import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Assessment,
  assess,
  ciFromChecks,
  isCodePath,
  mergeOrder,
  type PullRequest,
  stackOf,
  tierFor,
} from "./triage-prs";

const pr = (number: number, base: string, head: string): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/owner/repo/pull/${number}`,
  base,
  head,
  headSha: `sha${number}`,
  draft: false,
});

describe("triage-prs", () => {
  it("fetches PR refs with a narrow refspec and rejects missing refs and Git failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "triage-prs-"));
    const previousPath = process.env.PATH;
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };

    try {
      const source = join(directory, "source");
      const clone = join(directory, "clone");
      const bin = join(directory, "bin");
      mkdirSync(source);
      mkdirSync(bin);
      git(source, "init", "-b", "main");
      git(source, "config", "user.name", "Fixture");
      git(source, "config", "user.email", "fixture@example.com");
      writeFileSync(join(source, "app.ts"), "base\n");
      git(source, "add", ".");
      git(source, "commit", "-m", "base");
      git(source, "checkout", "-b", "codex/fix");
      writeFileSync(join(source, "app.ts"), "PR\n");
      writeFileSync(join(source, "app.test.ts"), "test\n");
      mkdirSync(join(source, "migrations"));
      writeFileSync(join(source, "migrations", "001.sql"), "migration\n");
      git(source, "add", ".");
      git(source, "commit", "-m", "PR");
      const headSha = git(source, "rev-parse", "HEAD");
      git(source, "update-ref", "refs/pull/1/head", headSha);
      git(source, "checkout", "main");
      writeFileSync(join(source, "app.ts"), "main\n");
      git(source, "add", ".");
      git(source, "commit", "-m", "conflict");
      git(directory, "clone", "--single-branch", "--branch", "main", source, clone);

      const listed = [
        {
          number: 1,
          title: "PR",
          url: pr(1, "main", "codex/fix").url,
          baseRefName: "main",
          headRefName: "codex/fix",
          headRefOid: headSha,
          isDraft: false,
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
        },
      ];
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\ncase "$1" in\nrepo) echo '${JSON.stringify({ defaultBranchRef: { name: "main" } })}';;\npr) echo '${JSON.stringify(listed)}';;\nesac\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}:${previousPath}`;

      const options = { cwd: clone, remote: "origin", fetch: true };
      const result = assess(options).assessments[0];
      expect(result).toMatchObject({
        codeLines: 3,
        testLines: 1,
        migrations: 1,
        mainConflicts: ["app.ts"],
        tier: "blocked",
      });
      expect(git(clone, "config", "--get-all", "remote.origin.fetch")).toBe(
        "+refs/heads/main:refs/remotes/origin/main",
      );
      expect(assess({ ...options, fetch: false }).assessments[0].mainConflicts).toEqual(["app.ts"]);
      git(clone, "update-ref", "-d", "refs/remotes/origin/main");
      git(clone, "update-ref", "-d", "refs/triage-prs/base/main");
      expect(() => assess({ ...options, fetch: false })).toThrow("rev-parse --verify origin/main");
      expect(() => assess({ ...options, remote: "missing" })).toThrow("fetch");
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("orders stacks parent before child and puts blocked stacks last", () => {
    const prs = [
      pr(3, "feat/b", "feat/c"),
      pr(1, "main", "feat/a"),
      pr(2, "feat/a", "feat/b"),
      pr(4, "main", "fix/x"),
    ];
    const stacks = stackOf(prs);
    const assessments = prs.map(
      (item): Assessment => ({
        pr: item,
        ...(stacks.get(item.number) as { parent: number | null; root: number }),
        behindParent: false,
        ci: "success",
        mainConflicts: item.number === 4 ? ["a.ts"] : [],
        codeLines: 10,
        testLines: 0,
        migrations: 0,
        conflictsWith: new Map(),
        tier: item.number === 4 ? "blocked" : "small",
      }),
    );

    expect(stacks.get(3)).toEqual({ parent: 2, root: 1 });
    expect(mergeOrder(assessments)).toEqual([[1, 2, 3], [4]]);
  });

  it("sizes by code and migrations, and blocks failing, conflicting or draft PRs", () => {
    const base = { ci: "success" as const, mainConflicts: 0, draft: false, migrations: 0 };

    expect(tierFor({ ...base, codeLines: 120 })).toBe("small");
    expect(tierFor({ ...base, codeLines: 120, migrations: 1 })).toBe("medium");
    expect(tierFor({ ...base, codeLines: 2000 })).toBe("large");
    expect(tierFor({ ...base, codeLines: 10, ci: "failure" })).toBe("blocked");
    expect(tierFor({ ...base, codeLines: 10, draft: true })).toBe("blocked");
    expect(isCodePath("app/tests/Feature/FooTest.php")).toBe(false);
    expect(isCodePath("src/foo.spec.ts")).toBe(false);
    expect(isCodePath("pnpm-lock.yaml")).toBe(false);
    expect(isCodePath("src/services/foo.ts")).toBe(true);
  });

  it("fails CI on any failed check and waits on unfinished ones", () => {
    expect(ciFromChecks([])).toBe("none");
    expect(ciFromChecks([{ conclusion: "SUCCESS", status: "COMPLETED" }])).toBe("success");
    expect(ciFromChecks([{ conclusion: "success" }, { conclusion: "failure" }])).toBe("failure");
    expect(ciFromChecks([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");

    for (const state of ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "REQUESTED", "WAITING"]) {
      expect(ciFromChecks([{ state: "SUCCESS" }, { state }])).toBe("pending");
    }
    for (const conclusion of ["ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]) {
      expect(ciFromChecks([{ state: "PENDING" }, { conclusion }])).toBe("failure");
    }
    for (const conclusion of ["NEUTRAL", "SKIPPED"]) {
      expect(ciFromChecks([{ conclusion, status: "COMPLETED" }])).toBe("success");
      expect(ciFromChecks([{ conclusion, status: "QUEUED" }])).toBe("pending");
    }
    for (const check of [
      {},
      { conclusion: null, status: "COMPLETED" },
      { conclusion: "", status: "completed" },
      { state: "NEW_STATE" },
      { conclusion: "NEW_CONCLUSION", status: "COMPLETED" },
    ]) {
      expect(ciFromChecks([check])).toBe("pending");
    }
  });
});
