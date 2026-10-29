#!/usr/bin/env bun
import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { homedir } from "node:os";
import { cac } from "cac";
import { execa } from "execa";
import { agentOutput, parseCli } from "../lib/agent-output";
import { readRemoteClaudePoolUrl } from "../lib/device";
import {
  forwardedMergeQueueArgs,
  mainMacQueueCommand,
  processRequests,
  submitRequest,
} from "../lib/merge-queue-forward";
import { githubBackend, projectForRepo } from "../lib/merge-queue-backend";
import {
  mergeQueueDirectory,
  processRepository,
  readMergeQueue,
  record,
  updateMergeQueue,
  validatePr,
  type QueueEntry,
} from "../lib/merge-queue";

// Set only by main-mac's inbox forced command: the spare Mac whose thread enqueued the PR.
const forwardedFrom = process.env.MERGE_QUEUE_FORWARDED_FROM;
const spareMac = Boolean(readRemoteClaudePoolUrl(homedir()));
const args = process.argv.slice(2);
const allowed = forwardedFrom || spareMac ? forwardedMergeQueueArgs(args) : args;
if (typeof allowed === "string") {
  console.error(`merge-queue: ${allowed}`);
  process.exit(64);
}
// Spare Macs (those using a remote pool) run no queue of their own; main-mac's queue takes their PRs.
if (!forwardedFrom && spareMac) {
  const [command, ...rest] = mainMacQueueCommand(allowed);
  const result = await execa(command, rest, {
    stdio: "inherit",
    reject: false,
  });
  process.exit(result.exitCode ?? 1);
}
if (forwardedFrom && allowed[0] === "add") {
  const result = await submitRequest(allowed, forwardedFrom, mergeQueueDirectory());
  (result.exitCode === 0 ? console.log : console.error)(result.output.trim());
  process.exit(result.exitCode);
}

agentOutput("merge-queue", {
  nativeJson: true,
  summary: (output) => output.trim(),
});
const cli = cac("merge-queue");
cli
  .option("--json", "Print structured results")
  .option("--verbose", "Print full command output")
  .option("--dry-run", "Inspect and print plan without changing queue or merging");
function output(value: unknown, summary: string, json?: boolean) {
  console.log(json ? JSON.stringify(value) : summary);
}
function identity(repo: string, pr: string) {
  projectForRepo(repo);
  const number = Number(pr);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("PR must be a positive integer");
  return { repo: repo.toLowerCase(), pr: number };
}
cli.command("status", "Read queue entries and history").action((options) => {
  const state = readMergeQueue();
  output(
    state,
    `merge-queue: ${state.entries.filter((entry) => entry.status === "queued").length} queued, ${state.entries.filter((entry) => entry.status === "failed").length} failed${Object.entries(
      state.environment ?? {},
    )
      .map(([repo, failure]) => `; ${repo}: ${failure.cause}; retry after ${failure.retryAt}`)
      .join("")}${Object.entries(state.deploys ?? {})
      .filter(([, deploy]) => deploy.status === "failed")
      .map(
        ([repo, deploy]) =>
          `; ${repo}: deploy of ${deploy.sha} failed: ${deploy.error}; log=${deploy.log}`,
      )
      .join("")}${Object.entries(state.nightly ?? {})
      .filter(([, nightly]) => nightly.status === "failed")
      .map(
        ([repo, nightly]) =>
          `; ${repo}: nightly full sign-off of ${nightly.sha} failed: ${nightly.error}; log=${nightly.log}`,
      )
      .join("")}`,
    options.json,
  );
});
cli
  .command("add <repo> <pr>", "Enqueue an approved PR with green sign-off")
  .option("--thread <id>", "Owning T3 thread")
  .action(async (repo, pr, options) => {
    const entry: QueueEntry = {
      ...identity(repo, pr),
      head: "",
      thread: options.thread,
      // Set only by process-requests for a spare Mac's forwarded add.
      host: process.env.MERGE_QUEUE_HOST,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
    };
    const backend = githubBackend(entry.repo);
    const remote = await backend.inspect(entry);
    validatePr(remote);
    entry.head = remote.headRefOid;
    if (!(await backend.signed(entry)))
      throw new Error("Recorded head must have a green signoff status");
    if (!options.dryRun)
      await updateMergeQueue((state) => {
        const existing = state.entries.find(
          (item) => item.repo === entry.repo && item.pr === entry.pr,
        );
        if (existing?.status === "queued" && existing.head === entry.head) return;
        if (existing)
          Object.assign(existing, entry, {
            signedHead: undefined,
            error: undefined,
            log: undefined,
            runs: undefined,
            failedAt: undefined,
            mergedAt: undefined,
            mergedMainSha: undefined,
          });
        else state.entries.push(entry);
        record(state, entry, "enqueued");
      });
    output(
      { dryRun: Boolean(options.dryRun), entry },
      `merge-queue: ${options.dryRun ? "would enqueue" : "queued"} ${entry.repo}#${entry.pr} ${entry.head}`,
      options.json,
    );
  });
for (const command of ["remove", "retry"])
  cli.command(`${command} <repo> <pr>`, `${command} an entry`).action(async (repo, pr, options) => {
    const id = identity(repo, pr);
    if (!options.dryRun)
      await updateMergeQueue((state) => {
        const entry = state.entries.find((item) => item.repo === id.repo && item.pr === id.pr);
        if (!entry || entry.status === "merged") throw new Error("No actionable queue entry");
        entry.status = command === "retry" ? "queued" : "removed";
        entry.error = undefined;
        entry.log = undefined;
        entry.runs = undefined;
        entry.failedAt = undefined;
        record(state, entry, command);
      });
    output(
      { ...id, command, dryRun: Boolean(options.dryRun) },
      `merge-queue: ${options.dryRun ? "would " : ""}${command} ${id.repo}#${id.pr}`,
      options.json,
    );
  });
cli
  .command("retry-deploy <repo>", "Deploy the last merged SHA again after a failed deploy")
  .action(async (repo, options) => {
    const { repo: id } = identity(repo, "1");
    if (!options.dryRun)
      await updateMergeQueue((state) => {
        const deploy = state.deploys?.[id];
        if (deploy?.status !== "failed") throw new Error("No failed deploy to retry");
        Object.assign(deploy, {
          status: "pending",
          error: undefined,
          log: undefined,
        });
      });
    output(
      { repo: id, dryRun: Boolean(options.dryRun) },
      `merge-queue: ${options.dryRun ? "would retry" : "retrying"} deploy for ${id}`,
      options.json,
    );
  });
cli
  .command("process-requests", "Run spare Macs' forwarded adds; launchd entrypoint")
  .action(async (options) => {
    const processed = await processRequests(mergeQueueDirectory(), async (args, from) => {
      const result = await execa(process.execPath, ["--no-env-file", import.meta.path, ...args], {
        env: { MERGE_QUEUE_HOST: from },
        reject: false,
        all: true,
      });
      return { exitCode: result.exitCode ?? 1, output: result.all ?? "" };
    });
    output({ processed }, `merge-queue: ${processed} forwarded requests processed`, options.json);
  });
cli
  .command("run [repo]", "Process queued repositories once; launchd entrypoint")
  .action(async (repo, options) => {
    const repos = repo
      ? [repo.toLowerCase()]
      : ACTIVE_PROJECTS.map((project) =>
          project.remoteUrl
            .replace("https://github.com/", "")
            .replace(/\.git$/, "")
            .toLowerCase(),
        );
    const plans = [];
    if (!options.dryRun) {
      const results = await Promise.allSettled(
        repos.map((repository) => processRepository(repository, githubBackend(repository))),
      );
      const errors = results.flatMap((result, index) =>
        result.status === "rejected" ? [`${repos[index]}: ${String(result.reason)}`] : [],
      );
      if (errors.length) throw new Error(errors.join("; "));
      output({ processed: repos }, "merge-queue: pass complete", options.json);
      return;
    }
    for (const repository of repos) {
      const backend = githubBackend(repository);
      if (options.dryRun) {
        const queued = readMergeQueue().entries.filter(
          (entry) => entry.repo === repository && entry.status === "queued",
        );
        const open = JSON.parse(
          (
            await execa("gh", [
              "pr",
              "list",
              "--repo",
              repository,
              "--state",
              "open",
              "--limit",
              "100",
              "--json",
              "number,reviewDecision,isDraft,headRefOid",
            ])
          ).stdout,
        );
        const plan = {
          repo: repository,
          base: await backend.base(),
          queued: queued.map((entry) => entry.pr),
          approvedOpen: open.filter(
            (pr: { reviewDecision: string; isDraft: boolean }) =>
              pr.reviewDecision === "APPROVED" && !pr.isDraft,
          ),
          action: queued.length
            ? "build candidate, verify with local sign-off, squash in order, then mise run deploy"
            : "no queued PRs; no merge planned",
        };
        plans.push(plan);
      } else await processRepository(repository, backend);
    }
    output(
      {
        dryRun: Boolean(options.dryRun),
        plans,
        directory: mergeQueueDirectory(),
      },
      options.dryRun
        ? `merge-queue: dry-run ${JSON.stringify(plans)}`
        : "merge-queue: pass complete",
      options.json,
    );
  });
cli.help();
try {
  parseCli(cli);
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
process.on("unhandledRejection", (error) => {
  console.error(String(error));
  process.exitCode = 1;
});
