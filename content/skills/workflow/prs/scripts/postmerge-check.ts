#!/usr/bin/env bun

import { agentOutput } from "./agent-output";

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { command, finish, options, prTarget, Stop } from "./pr-cli";

const HELP = `Usage: bun postmerge-check.ts <pr-url|merge-sha> --repo <owner/repo|checkout>
       --workflow <name|file|id> --timeout <seconds> [--json] [--verbose]

Find the push workflow run for the exact merged commit, wait within the budget, and
report its attempt, timestamps, conclusion, failed jobs/steps and links. No writes or revert.
--timeout 0 inspects once without waiting. A full commit SHA is required for SHA input.
Uses bounded gh run watch as the CLI fallback; open-PR harness watchers cannot watch
a merged-commit workflow. Exit 75 returns a receipt that can be inspected again later.
Exit: 0 success, 1 failed/error, 2 invalid/unmerged/missing commit, 75 pending/not found.
Needs authenticated gh. Failures name a full log; --json emits one object; --verbose prints stage output.`;

interface Run {
  id: number;
  run_attempt: number;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  run_started_at: string;
  updated_at: string;
}

interface Job {
  name: string;
  conclusion: string | null;
  html_url: string;
  started_at: string;
  completed_at: string;
  steps: { name: string; conclusion: string | null; number: number }[];
}

export async function postmerge(
  argv: string[],
): Promise<{ code: number; receipt: Record<string, unknown> }> {
  const receipt: Record<string, unknown> = { version: 1, run: null, failedStages: [] };

  try {
    const parsed = options(argv, ["--repo", "--workflow", "--timeout"], ["--json"]);
    const seconds = Number(parsed.values["--timeout"]);
    if (
      !/^\d+(?:\.\d+)?$/.test(parsed.values["--timeout"]) ||
      !Number.isFinite(seconds) ||
      seconds > 86400
    )
      throw new Stop(2, "--timeout must be 0–86400 seconds");
    const deadline = Date.now() + seconds * 1000;
    const suppliedRepo = parsed.values["--repo"];
    const isPath = existsSync(suppliedRepo);
    const cwd = isPath ? realpathSync(resolve(suppliedRepo)) : process.cwd();
    const gh = (args: string[]) => {
      const remaining = seconds === 0 ? 30000 : Math.max(1, deadline - Date.now());
      const result = command(cwd, ["gh", ...args], remaining);

      if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT")
        throw new Stop(75, "Wait budget expired");
      if (result.error || result.status !== 0)
        throw new Stop(
          1,
          `gh ${args.slice(0, 2).join(" ")} failed: ${result.error?.message ?? result.stderr?.trim()}`,
        );

      return result.stdout.trim();
    };
    const repo = isPath
      ? (JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"])) as { nameWithOwner: string })
          .nameWithOwner
      : suppliedRepo;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Stop(2, "--repo must be owner/repo or a repository checkout");
    Object.assign(receipt, {
      repo,
      target: parsed.target,
      workflow: parsed.values["--workflow"],
      timeoutSeconds: seconds,
    });

    let sha = parsed.target.toLowerCase();
    if (parsed.target.startsWith("https:")) {
      const target = prTarget(parsed.target);
      if (target.repo.toLowerCase() !== repo.toLowerCase())
        throw new Stop(2, "PR URL belongs to another repository");
      const pr = JSON.parse(
        gh(["pr", "view", parsed.target, "--json", "state,mergeCommit,url"]),
      ) as { state: string; mergeCommit: { oid: string } | null; url: string };
      if (pr.state !== "MERGED" || !pr.mergeCommit) throw new Stop(2, "PR has no merged commit");
      sha = pr.mergeCommit.oid;
      receipt.pr = pr.url;
    }
    if (!/^[a-f0-9]{40}$/.test(sha))
      throw new Stop(2, "Expected a full merge commit SHA or merged PR URL");
    receipt.mergedSha = sha;
    try {
      const commit = gh(["api", `repos/${repo}/commits/${sha}`, "--jq", ".sha"]);
      if (commit !== sha) throw new Stop(2, "No matching commit");
    } catch (error) {
      if (error instanceof Stop && error.code === 1 && /HTTP (404|422)/.test(error.message))
        throw new Stop(2, "No matching commit in this repository");
      throw error;
    }

    let selected: number | undefined;
    while (selected === undefined) {
      const runs = JSON.parse(
        gh([
          "run",
          "list",
          "--repo",
          repo,
          "--workflow",
          parsed.values["--workflow"],
          "--commit",
          sha,
          "--event",
          "push",
          "--limit",
          "100",
          "--json",
          "databaseId,headSha,event,createdAt",
        ]),
      ) as { databaseId: number; headSha: string; event: string; createdAt: string }[];
      selected = runs
        .filter((run) => run.headSha === sha && run.event === "push")
        .sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.databaseId - a.databaseId,
        )[0]?.databaseId;
      if (selected !== undefined) break;
      if (Date.now() >= deadline) throw new Stop(75, "No matching workflow run found yet");
      console.error("postmerge-check: waiting for the exact merge-commit run");
      await Bun.sleep(Math.max(0, Math.min(5000, deadline - Date.now())));
    }

    receipt.run = { id: selected, url: `https://github.com/${repo}/actions/runs/${selected}` };
    const inspect = (): Run => {
      const run = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${selected}`])) as Run;
      if (run.head_sha !== sha || run.event !== "push")
        throw new Stop(2, "Selected run does not match the merge commit");
      receipt.run = {
        id: run.id,
        attempt: run.run_attempt,
        url: run.html_url,
        status: run.status,
        conclusion: run.conclusion,
        queuedAt: run.created_at,
        startedAt: run.run_started_at,
        endedAt: run.status === "completed" ? run.updated_at : null,
      };
      receipt.conclusion = run.conclusion;

      return run;
    };
    let run = inspect();
    while (run.status !== "completed") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Stop(75, "Matching run is still pending");
      console.error(`postmerge-check: watching ${run.html_url} (attempt ${run.run_attempt})`);
      const watched = command(
        cwd,
        [
          "gh",
          "run",
          "watch",
          String(selected),
          "--repo",
          repo,
          "--exit-status",
          "--compact",
          "--interval",
          "5",
        ],
        remaining,
      );
      const output = `${watched.stdout ?? ""}${watched.stderr ?? ""}`;
      if (output) process.stderr.write(output);
      if (watched.error && "code" in watched.error && watched.error.code === "ETIMEDOUT")
        throw new Stop(75, "Matching run is still pending at timeout");
      if (watched.error) throw new Stop(1, watched.error.message);
      run = inspect();
      if (run.status !== "completed" && watched.status !== 0)
        throw new Stop(1, `Workflow watcher failed (exit ${watched.status})`);
    }

    const pages = JSON.parse(
      gh([
        "api",
        `repos/${repo}/actions/runs/${selected}/attempts/${run.run_attempt}/jobs?per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    ) as { jobs: Job[] }[];
    const failed = (conclusion: string | null) =>
      conclusion !== null && !["success", "skipped", "neutral"].includes(conclusion);
    const jobs = pages.flatMap((page) => page.jobs);
    receipt.failedStages = jobs
      .filter((job) => failed(job.conclusion))
      .map((job) => ({
        name: job.name,
        conclusion: job.conclusion,
        url: job.html_url,
        startedAt: job.started_at,
        endedAt: job.completed_at,
        steps: job.steps
          .filter((step) => failed(step.conclusion))
          .map((step) => ({
            name: step.name,
            conclusion: step.conclusion,
            url: `${job.html_url}#step:${step.number}:1`,
          })),
      }));
    const success = run.conclusion === "success";
    receipt.status = success ? "success" : "failed";
    if (!success)
      receipt.nextAction =
        "Inspect the failed stages, then fix or deliberately revert the relevant change; nothing was reverted automatically";

    return { code: success ? 0 : 1, receipt };
  } catch (error) {
    const code = error instanceof Stop ? error.code : 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`postmerge-check: ${message}`);

    return {
      code,
      receipt: {
        ...receipt,
        status: code === 75 ? "pending" : "error",
        exitCode: code,
        error: message,
      },
    };
  }
}

if (import.meta.main) {
  agentOutput("postmerge-check", { nativeJson: true });

  const argv = process.argv.slice(2);

  if (argv.includes("--help")) {
    if (argv.includes("--json")) finish({ help: HELP }, 0, true);
    else console.log(HELP);
  } else {
    const result = await postmerge(argv);
    finish(result.receipt, result.code, argv.includes("--json"));
  }
}
