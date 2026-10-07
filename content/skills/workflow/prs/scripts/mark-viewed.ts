#!/usr/bin/env bun

// Ticks GitHub's "Viewed" box, for the account gh uses, on pull request files that need no line-by-line review.
// Usage: bun mark-viewed.ts <pr-url> [--dry-run]

import { spawnSync } from "node:child_process";

export type Kind = "generated" | "test" | "lock" | "asset";

// Checked in order: snapshots count as generated, not as tests.
const KIND_PATTERNS: [Kind, RegExp[]][] = [
  [
    "generated",
    [
      /\.snap$/,
      /(^|\/)__snapshots__\//,
      /(^|\/)(__generated__|generated)\//,
      /\.(generated|gen)\.[a-z]+$/,
      /\.g\.dart$/,
      /\.pb\.go$/,
      /_pb2\.pyi?$/,
      /\.min\.(js|css)$/,
      /\.map$/,
    ],
  ],
  [
    "test",
    [
      /\.(test|spec)\.[cm]?[jt]sx?$/,
      /(_test|_spec)\.[a-z]+$/,
      /(^|\/)test_[^/]+\.py$/,
      /Tests?\.(php|java|kt|swift|cs)$/,
      /(^|\/)(tests?|spec|__tests__|e2e|fixtures)\//i,
    ],
  ],
  [
    "lock",
    [
      /\.lock$/,
      /(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lockb|go\.sum|npm-shrinkwrap\.json)$/,
    ],
  ],
  [
    "asset",
    [
      /\.(png|jpe?g|gif|webp|avif|heic|ico|icns|svg|ttf|otf|woff2?|eot|mp3|mp4|mov|webm|wav|ogg|pdf)$/i,
    ],
  ],
];

// A removed line like these means a test or assertion was deleted or rewritten.
const TEST_LINE =
  /\b(it|test|describe|context|scenario)(\.\w+)?\s*\(|\bexpect\s*\(|assert\w*!?\s*\(|^\s*assert\s|\b(assert|require)\.\w+\s*\(|\bdef test_|\bfunction test\w*\s*\(|@Test\b|#\[test\]|\bfunc Test\w+\s*\(|\bt\.(Error|Fatal)f?\s*\(/i;

// An added line like these stops tests from running.
const SKIP_LINE =
  /\.(skip|only|todo)\s*\(|\b[xf](it|describe|test)\s*\(|markTest(Skipped|Incomplete)|@(skip|Disabled|Ignore)\b|pytest\.mark\.(skip|xfail)|\bt\.Skip|#\[ignore\]|->(skip|todo)\s*\(/;

export interface ChangedFile {
  filename: string;
  status: string;
  changes: number;
  // GitHub sends null for pure renames, binary files, and diffs too large to show.
  patch: string | null;
}

export function kindOf(path: string): Kind | null {
  for (const [kind, patterns] of KIND_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(path))) {
      return kind;
    }
  }

  return null;
}

/** Why a test file still needs review, or null when it only adds or extends tests. */
export function testReviewReason(file: ChangedFile): string | null {
  if (file.status === "removed") {
    return "file deleted";
  }

  if (file.patch === null) {
    return file.changes === 0 ? null : "diff too large to check";
  }

  const lines = file.patch.split("\n");

  if (lines.some((line) => line.startsWith("-") && TEST_LINE.test(line.slice(1)))) {
    return "removes or changes a test or assertion";
  }

  if (lines.some((line) => line.startsWith("+") && SKIP_LINE.test(line.slice(1)))) {
    return "adds a skip or focus marker";
  }

  return null;
}

function gh(args: string[]): string {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

function main(argv: string[]): void {
  const dryRun = argv.includes("--dry-run");
  const target = argv.find((arg) => !arg.startsWith("--"));

  if (!target || argv.includes("--help")) {
    console.log("Usage: bun mark-viewed.ts <pr-url> [--dry-run]");
    process.exit(target ? 0 : 1);
  }

  const pr = JSON.parse(gh(["pr", "view", target, "--json", "id,number,url"])) as {
    id: string;
    number: number;
    url: string;
  };
  const [, owner, repo] = new URL(pr.url).pathname.split("/");
  const files = gh([
    "api",
    "--paginate",
    `repos/${owner}/${repo}/pulls/${pr.number}/files`,
    "--jq",
    ".[] | {filename, status, changes, patch}",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChangedFile);

  const viewed: { path: string; kind: Kind }[] = [];
  const kept: { path: string; reason: string }[] = [];

  for (const file of files) {
    const kind = kindOf(file.filename);

    if (kind === null) {
      continue;
    }

    const reason = kind === "test" ? testReviewReason(file) : null;

    if (reason) {
      kept.push({ path: file.filename, reason });
    } else {
      viewed.push({ path: file.filename, kind });
    }
  }

  if (!dryRun) {
    for (let start = 0; start < viewed.length; start += 50) {
      const batch = viewed.slice(start, start + 50);
      const fields = batch.map(
        (file, index) =>
          `f${index}: markFileAsViewed(input: {pullRequestId: ${JSON.stringify(pr.id)}, path: ${JSON.stringify(file.path)}}) { clientMutationId }`,
      );

      gh(["api", "graphql", "-f", `query=mutation { ${fields.join("\n")} }`]);
    }
  }

  const reviewed = files.length - viewed.length;

  console.log(
    `${dryRun ? "Would mark" : "Marked"} ${viewed.length} of ${files.length} files viewed on ${pr.url}`,
  );

  for (const file of viewed) {
    console.log(`  ✅ ${file.kind.padEnd(9)} ${file.path}`);
  }

  console.log(
    `${reviewed} files left for review${kept.length > 0 ? ", including these test files:" : "."}`,
  );

  for (const file of kept) {
    console.log(`  👀 ${file.path} (${file.reason})`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
