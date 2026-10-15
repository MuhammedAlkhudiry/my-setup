#!/usr/bin/env bun

// Ranks a GitHub repository's open pull requests from easiest to hardest to merge, with stacks, CI, conflicts and a merge order.
// Usage: bun triage-prs.ts [repo-path] [--remote <name>] [--no-fetch] [--json] [--verbose]

import { agentOutput } from "../../prs/scripts/agent-output";

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Lines that count as review effort: application code, not tests, docs, lockfiles, snapshots or generated data.
const NON_CODE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(_test|_spec)\.[a-z]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /Test\.(php|java|kt|swift|cs)$/,
  /(^|\/)(tests?|spec|__tests__|__snapshots__|e2e|fixtures)\//i,
  /\.snap$/,
  /(^|\/)docs?\//,
  /\.(md|mdx|txt)$/,
  /(^|\/)coverage\//,
  /\.lock$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lockb|go\.sum)$/,
  /(^|\/)\.pest\//,
];

const TEST_PATTERNS = NON_CODE_PATTERNS.slice(0, 6);

export type Tier = "blocked" | "small" | "medium" | "large";

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  headSha: string;
  draft: boolean;
}

export interface Assessment {
  pr: PullRequest;
  root: number;
  parent: number | null;
  /** A stacked PR whose head lacks its parent's latest commits and needs a restack. */
  behindParent: boolean;
  ci: "success" | "failure" | "pending" | "none";
  mainConflicts: string[];
  codeLines: number;
  testLines: number;
  migrations: number;
  conflictsWith: Map<number, string[]>;
  tier: Tier;
}

interface Check {
  conclusion?: string;
  state?: string;
  status?: string;
}

export function isCodePath(path: string): boolean {
  return !NON_CODE_PATTERNS.some((pattern) => pattern.test(path));
}

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(path));
}

export function isMigrationPath(path: string): boolean {
  return /(^|\/)migrations?\//.test(path);
}

export function tierFor(input: {
  ci: Assessment["ci"];
  mainConflicts: number;
  draft: boolean;
  codeLines: number;
  migrations: number;
}): Tier {
  if (input.ci === "failure" || input.mainConflicts > 0 || input.draft) {
    return "blocked";
  }

  // Overlaps with other PRs stay out of the score: they are mostly shared registry files, resolved by whichever PR merges second.
  const effort = input.codeLines + input.migrations * 300;

  if (effort < 300) {
    return "small";
  }

  return effort < 1500 ? "medium" : "large";
}

/** Maps each PR to its parent PR (the PR whose head branch is its base) and to the stack root. */
export function stackOf(prs: PullRequest[]): Map<number, { parent: number | null; root: number }> {
  const byHead = new Map(prs.map((pr) => [pr.head, pr]));
  const result = new Map<number, { parent: number | null; root: number }>();

  for (const pr of prs) {
    const parent = byHead.get(pr.base) ?? null;
    let root = pr;
    const seen = new Set<number>();

    while (byHead.has(root.base) && !seen.has(root.number)) {
      seen.add(root.number);
      root = byHead.get(root.base) as PullRequest;
    }

    result.set(pr.number, { parent: parent?.number ?? null, root: root.number });
  }

  return result;
}

/** Combines check results into one state: any failure fails, any unfinished check is pending. */
export function ciFromChecks(checks: Check[]): Assessment["ci"] {
  if (checks.length === 0) {
    return "none";
  }

  const results = checks.map((check) => (check.conclusion || check.state || "").toUpperCase());

  if (
    results.some((result) =>
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"].includes(result),
    )
  ) {
    return "failure";
  }

  if (checks.some((check) => check.status && check.status.toUpperCase() !== "COMPLETED")) {
    return "pending";
  }

  return "success";
}

const TIER_ORDER: Tier[] = ["small", "medium", "large", "blocked"];
const TIER_TITLES: Record<Tier, string> = {
  small: "🟩 Small: review in minutes",
  medium: "🟨 Medium",
  large: "🟧 Large: needs real review",
  blocked: "🟥 Blocked: failing CI, conflicts with the default branch, or draft",
};

/** Stacks ordered by their hardest member, overlaps and size; each stack's PRs parent before child. */
export function mergeOrder(assessments: Assessment[]): number[][] {
  const byRoot = new Map<number, Assessment[]>();

  for (const assessment of assessments) {
    byRoot.set(assessment.root, [...(byRoot.get(assessment.root) ?? []), assessment]);
  }

  const rank = (stack: Assessment[]): number =>
    Math.max(...stack.map((item) => TIER_ORDER.indexOf(item.tier))) * 100_000 +
    stack.reduce((sum, item) => sum + item.conflictsWith.size, 0) * 1_000 +
    stack.reduce((sum, item) => sum + item.codeLines, 0) / 100;

  return [...byRoot.values()]
    .sort((a, b) => rank(a) - rank(b))
    .map((stack) => {
      const ordered: number[] = [];
      const pending = [...stack];

      while (pending.length > 0) {
        const next = pending.findIndex(
          (item) => item.parent === null || ordered.includes(item.parent),
        );
        const [item] = pending.splice(next === -1 ? 0 : next, 1);
        ordered.push(item.pr.number);
      }

      return ordered;
    });
}

export function runner(cwd: string) {
  return (command: string, args: string[], allowedStatuses = [0]) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error || result.status === null || !allowedStatuses.includes(result.status)) {
      throw new Error(
        `${command} ${args.join(" ")} failed (exit ${result.status}): ${result.error?.message || result.stderr?.trim() || result.stdout?.trim()}`,
      );
    }

    return {
      ok: result.status === 0,
      out: result.stdout ?? "",
      err: result.stderr ?? "",
      status: result.status,
    };
  };
}

export const baseRef = (branch: string): string => `refs/triage-prs/base/${branch}`;

/** Narrow explicit refspecs also work in single-branch clones, without changing their fetch configuration. */
export function fetchRefs(
  run: ReturnType<typeof runner>,
  remote: string,
  bases: string[],
  prs: number[],
): void {
  run("git", [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    remote,
    ...[...new Set(bases)].map((branch) => `+refs/heads/${branch}:${baseRef(branch)}`),
    ...prs.map((number) => `+refs/pull/${number}/head:refs/triage-prs/pr/${number}`),
  ]);
}

export function assess(options: { cwd: string; remote: string; fetch: boolean }): {
  defaultBranch: string;
  assessments: Assessment[];
} {
  const run = runner(options.cwd);
  const git = (args: string[], allowedStatuses = [0]) => run("git", args, allowedStatuses);
  const ref = (branch: string) => {
    const cached = baseRef(branch);

    return options.fetch || git(["show-ref", "--verify", "--quiet", cached], [0, 1]).ok
      ? cached
      : `${options.remote}/${branch}`;
  };

  git(["rev-parse", "--git-dir"]);

  const repo = run("gh", ["repo", "view", "--json", "defaultBranchRef"]);

  const defaultBranch = (JSON.parse(repo.out) as { defaultBranchRef: { name: string } })
    .defaultBranchRef.name;
  const listed = run("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,title,url,baseRefName,headRefName,headRefOid,isDraft,statusCheckRollup",
  ]);

  const raw = JSON.parse(listed.out) as {
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    isDraft: boolean;
    statusCheckRollup: Check[] | null;
  }[];
  const prs: PullRequest[] = raw.map((item) => ({
    number: item.number,
    title: item.title,
    url: item.url,
    base: item.baseRefName,
    head: item.headRefName,
    headSha: item.headRefOid,
    draft: item.isDraft,
  }));
  if (options.fetch) {
    const bases = new Set([defaultBranch, ...prs.map((pr) => pr.base)]);
    fetchRefs(
      run,
      options.remote,
      [...bases],
      prs.map((pr) => pr.number),
    );
  }

  // Resolve every input before assessment; --no-fetch requires these objects locally.
  for (const branch of new Set([defaultBranch, ...prs.map((pr) => pr.base)])) {
    git(["rev-parse", "--verify", `${ref(branch)}^{commit}`]);
  }
  for (const pr of prs) {
    git(["rev-parse", "--verify", `${pr.headSha}^{commit}`]);
  }

  const stacks = stackOf(prs);

  // GitHub attaches no checks to PRs whose base branch CI does not target, such as stacked PRs; read the head commit's runs instead.
  const ciState = (pr: PullRequest, rollup: Check[]): Assessment["ci"] => {
    if (rollup.length > 0) {
      return ciFromChecks(rollup);
    }

    const runs = run("gh", [
      "run",
      "list",
      "--commit",
      pr.headSha,
      "--limit",
      "50",
      "--json",
      "workflowName,status,conclusion,createdAt",
    ]);
    const all = JSON.parse(runs.out) as {
      workflowName: string;
      status: string;
      conclusion: string;
      createdAt: string;
    }[];
    const latest = new Map<string, (typeof all)[number]>();

    for (const item of all) {
      const current = latest.get(item.workflowName);

      if (!current || current.createdAt < item.createdAt) {
        latest.set(item.workflowName, item);
      }
    }

    return ciFromChecks([...latest.values()]);
  };

  const conflictingPaths = (left: string, right: string): string[] => {
    const result = git(["merge-tree", "--write-tree", "--name-only", left, right], [0, 1]);

    if (result.ok) {
      return [];
    }

    const [, ...rest] = result.out.split("\n\n")[0].split("\n");

    return rest.filter(Boolean);
  };

  const numstat = (from: string, to: string) =>
    git(["diff", "--numstat", from, to])
      .out.split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, path] = line.split("\t");

        return { path, lines: (Number(added) || 0) + (Number(removed) || 0) };
      });

  const mainRef = ref(defaultBranch);
  const headOf = new Map(prs.map((pr) => [pr.number, pr.headSha]));

  const assessments = prs.map((pr, index): Assessment => {
    const head = pr.headSha;
    const stack = stacks.get(pr.number) as { parent: number | null; root: number };

    // A stacked PR's own changes: when its head already contains the default branch, compare it with its base branch
    // merged into the default branch; otherwise the default branch's newer changes would count as the PR's own.
    const headHasMain = git(["merge-base", "--is-ancestor", mainRef, head], [0, 1]).ok;
    const mergedBase =
      pr.base === defaultBranch || !headHasMain
        ? null
        : git(["merge-tree", "--write-tree", mainRef, ref(pr.base)], [0, 1])
            .out.split("\n")[0]
            .trim();
    const baseline = mergedBase || git(["merge-base", ref(pr.base), head]).out.trim();
    const files = numstat(baseline, head);

    return {
      pr,
      root: stack.root,
      parent: stack.parent,
      behindParent:
        stack.parent !== null &&
        !git(["merge-base", "--is-ancestor", headOf.get(stack.parent) as string, head], [0, 1]).ok,
      ci: ciState(pr, raw[index].statusCheckRollup ?? []),
      mainConflicts: conflictingPaths(mainRef, head),
      codeLines: files
        .filter((file) => isCodePath(file.path))
        .reduce((sum, file) => sum + file.lines, 0),
      testLines: files
        .filter((file) => isTestPath(file.path))
        .reduce((sum, file) => sum + file.lines, 0),
      migrations: files.filter((file) => isMigrationPath(file.path)).length,
      conflictsWith: new Map(),
      tier: "small",
    };
  });

  for (let i = 0; i < assessments.length; i++) {
    for (let j = i + 1; j < assessments.length; j++) {
      const left = assessments[i];
      const right = assessments[j];

      if (left.root === right.root) {
        continue;
      }

      const paths = conflictingPaths(left.pr.headSha, right.pr.headSha);

      if (paths.length > 0) {
        left.conflictsWith.set(right.pr.number, paths);
        right.conflictsWith.set(left.pr.number, paths);
      }
    }
  }

  for (const assessment of assessments) {
    assessment.tier = tierFor({
      ci: assessment.ci,
      mainConflicts: assessment.mainConflicts.length,
      draft: assessment.pr.draft,
      codeLines: assessment.codeLines,
      migrations: assessment.migrations,
    });
  }

  return { defaultBranch, assessments };
}

function textReport(defaultBranch: string, assessments: Assessment[]): string {
  const lines = [`triage-prs: ${assessments.length} open PRs; base=${defaultBranch}`];

  for (const tier of TIER_ORDER) {
    for (const item of assessments.filter((item) => item.tier === tier).sort((a, b) => a.codeLines - b.codeLines)) {
      lines.push(JSON.stringify({
        pr: item.pr.url, title: item.pr.title, tier: TIER_TITLES[tier],
        codeLines: item.codeLines, testLines: item.testLines, ci: item.ci,
        draft: item.pr.draft, parent: item.parent, behindParent: item.behindParent,
        migrations: item.migrations, mainConflicts: item.mainConflicts,
        conflictsWith: Object.fromEntries(item.conflictsWith),
      }));
    }
  }
  lines.push(`mergeOrder=${JSON.stringify(mergeOrder(assessments))}`);

  return lines.join("\n");
}

if (import.meta.main) {
  agentOutput("triage-prs", { nativeJson: true, summary: (output) => output.split("\n")[0] });

  const argv = process.argv.slice(2);

  if (argv.includes("--help")) {
    console.log(
      "Usage: bun triage-prs.ts [repo-path] [--remote <name>] [--no-fetch] [--json] [--verbose]\n\n" +
        "Ranks the repository's open GitHub PRs by merge effort. repo-path defaults to the current directory;\n" +
        "--remote defaults to origin. Needs git 2.38+ and an authenticated gh.",
    );
    process.exit(0);
  }

  const remoteIndex = argv.indexOf("--remote");
  const remote = remoteIndex === -1 ? "origin" : argv[remoteIndex + 1];
  const path = argv.find(
    (arg, index) => !arg.startsWith("--") && (remoteIndex === -1 || index !== remoteIndex + 1),
  );
  const { defaultBranch, assessments } = assess({
    cwd: resolve(path ?? "."),
    remote,
    fetch: !argv.includes("--no-fetch"),
  });

  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        assessments.map((item) => ({
          ...item,
          conflictsWith: Object.fromEntries(item.conflictsWith),
        })),
        null,
        2,
      ),
    );
  } else {
    console.log(textReport(defaultBranch, assessments));
  }
}
