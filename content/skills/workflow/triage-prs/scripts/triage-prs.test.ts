import { describe, expect, it } from "bun:test";

import {
  type Assessment,
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
  });
});
