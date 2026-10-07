#!/usr/bin/env bun

// Ranks a GitHub repository's open pull requests from easiest to hardest to merge, with stacks, CI, conflicts and a merge order.
// Usage: bun triage-prs.ts [repo-path] [--remote <name>] [--no-fetch] [--json]

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

function runner(cwd: string) {
  return (command: string, args: string[]): { ok: boolean; out: string } => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

    return { ok: result.status === 0, out: result.stdout ?? "" };
  };
}

function assess(options: { cwd: string; remote: string; fetch: boolean }): {
  defaultBranch: string;
  assessments: Assessment[];
} {
  const run = runner(options.cwd);
  const git = (args: string[]) => run("git", args);
  const ref = (branch: string) => `${options.remote}/${branch}`;

  if (!git(["rev-parse", "--git-dir"]).ok) {
    throw new Error(`${options.cwd} is not a git repository.`);
  }

  if (options.fetch) {
    git(["fetch", "--quiet", options.remote, "--prune"]);
  }

  const repo = run("gh", ["repo", "view", "--json", "defaultBranchRef"]);

  if (!repo.ok) {
    throw new Error("gh repo view failed; check that gh is authenticated for this repository.");
  }

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

  if (!listed.ok) {
    throw new Error("gh pr list failed.");
  }

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
    const all = runs.ok
      ? (JSON.parse(runs.out || "[]") as {
          workflowName: string;
          status: string;
          conclusion: string;
          createdAt: string;
        }[])
      : [];
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
    const result = git(["merge-tree", "--write-tree", "--name-only", left, right]);

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
  const headOf = new Map(prs.map((pr) => [pr.number, pr.head]));

  const assessments = prs.map((pr, index): Assessment => {
    const head = ref(pr.head);
    const stack = stacks.get(pr.number) as { parent: number | null; root: number };

    // A stacked PR's own changes: when its head already contains the default branch, compare it with its base branch
    // merged into the default branch; otherwise the default branch's newer changes would count as the PR's own.
    const headHasMain = git(["merge-base", "--is-ancestor", mainRef, head]).ok;
    const mergedBase =
      pr.base === defaultBranch || !headHasMain
        ? null
        : git(["merge-tree", "--write-tree", mainRef, ref(pr.base)])
            .out.split("\n")[0]
            .trim();
    const baseline = mergedBase || git(["merge-base", ref(pr.base), head]).out.trim() || mainRef;
    const files = numstat(baseline, head);

    return {
      pr,
      root: stack.root,
      parent: stack.parent,
      behindParent:
        stack.parent !== null &&
        !git(["merge-base", "--is-ancestor", ref(headOf.get(stack.parent) as string), head]).ok,
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

      const paths = conflictingPaths(ref(left.pr.head), ref(right.pr.head));

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

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function markdown(defaultBranch: string, assessments: Assessment[]): string {
  const urls = new Map(assessments.map((item) => [item.pr.number, item.pr.url]));
  const link = (number: number) => `[#${number}](${urls.get(number)})`;
  const counts = TIER_ORDER.map(
    (tier) => `${assessments.filter((item) => item.tier === tier).length} ${tier}`,
  );
  const lines: string[] = [
    `# PR triage: ${assessments.length} open PRs`,
    "",
    counts.join(" · "),
    "",
    "Lines count application code only; tests, docs, lockfiles and generated data are excluded.",
    "",
  ];

  for (const tier of TIER_ORDER) {
    const items = assessments
      .filter((item) => item.tier === tier)
      .sort((a, b) => a.codeLines - b.codeLines);

    if (items.length === 0) {
      continue;
    }

    lines.push(
      `## ${TIER_TITLES[tier]}`,
      "",
      "| PR | Lines | Tests | CI | Notes |",
      "|---|---|---|---|---|",
    );

    for (const item of items) {
      const notes: string[] = [];

      if (item.parent) {
        notes.push(`stacked on ${link(item.parent)}${item.behindParent ? ", behind it" : ""}`);
      }

      if (item.migrations > 0) {
        notes.push(`${item.migrations} migration${item.migrations > 1 ? "s" : ""}`);
      }

      if (item.mainConflicts.length > 0) {
        notes.push(
          `conflicts with ${defaultBranch}: ${item.mainConflicts.map(basename).join(", ")}`,
        );
      }

      if (item.conflictsWith.size > 0) {
        const files = [...new Set([...item.conflictsWith.values()].flat().map(basename))];
        const shown =
          files.slice(0, 2).join(", ") + (files.length > 2 ? ` +${files.length - 2}` : "");
        notes.push(
          `overlaps ${item.conflictsWith.size} PR${item.conflictsWith.size > 1 ? "s" : ""} in ${shown}`,
        );
      }

      if (item.pr.draft) {
        notes.push("draft");
      }

      lines.push(
        `| ${link(item.pr.number)} ${item.pr.title} | ${item.codeLines} | ${item.testLines} | ${item.ci} | ${notes.join("; ")} |`,
      );
    }

    lines.push("");
  }

  lines.push("## Merge order", "");
  mergeOrder(assessments).forEach((stack, index) => {
    lines.push(`${index + 1}. ${stack.map(link).join(" → ")}`);
  });

  return lines.join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);

  if (argv.includes("--help")) {
    console.log(
      "Usage: bun triage-prs.ts [repo-path] [--remote <name>] [--no-fetch] [--json]\n\n" +
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
    console.log(markdown(defaultBranch, assessments));
  }
}
