#!/usr/bin/env bun

import { agentOutput } from "../lib/agent-output";
import { parseArgs } from "node:util";
import { cleanupWorktrees, writeCleanupCache } from "../lib/worktree-cleanup";

agentOutput("worktree-cleanup", {
  nativeJson: true,
  summary: (output) =>
    output.split("\n").find((line) => line.startsWith("worktree-cleanup:")) ??
    "worktree-cleanup: ok",
  failures: (output, errors) => {
    try {
      return JSON.parse(output).errors;
    } catch {
      return errors.trim().split("\n").filter(Boolean);
    }
  },
});

function bytes(value: number | null): string {
  return value === null ? "unknown" : `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: worktree-cleanup [--json] [--verbose] [--apply <plan-id|path>]

Inspect registered worktrees and local branches in the configured active projects.
Dry run writes a private plan with an ID. --apply <plan> only rechecks and removes its listed entries.
Requires a merged/closed PR at the exact local head; ancestry alone keeps fresh starts.
Only ~/.t3/worktrees and project-root worktrees are eligible; external temporary work stays.
Detached heads always stay. PR completion, commit and file changes have a four-hour grace period.
Active T3 threads (including idle, unsettled threads) protect their bindings; busy projects stay.
Fresh GitHub PR and remote refs are required; failed safety checks keep the work.
Ignored build/dependency files do not make Git status dirty. Locked worktrees stay.
Branch sizes are 0: deleting refs does not reclaim shared Git objects or run GC.
Space is allocated worktree bytes (du), an estimate on filesystems with shared blocks.
Project refs are unchanged during dry runs. Temporary snapshots are deleted.
A small summary is cached in ~/.local/state/my-setup/worktree-cleanup.json for doctor.`);
    return;
  }

  const report = await cleanupWorktrees({ apply: values.apply });
  try {
    if (report.dryRun) await writeCleanupCache(report);
  } catch (error) {
    report.errors.push(`cannot cache the cleanup summary for doctor: ${String(error)}`);
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const entry of report.entries) {
      const pr = entry.pr ? `#${entry.pr.number} ${entry.pr.state}` : "none";
      const clean =
        entry.clean === null
          ? entry.kind === "branch"
            ? "not checked out"
            : "unknown"
          : entry.clean
            ? "yes"
            : "no";
      console.log(`\n${entry.project} ${entry.kind}: ${entry.path ?? entry.branch ?? "detached"}`);
      console.log(
        `  branch=${entry.branch ?? "detached"} PR=${pr} clean=${clean} unpushed=${entry.unpushedCommits ?? "unknown"} size=${bytes(entry.sizeBytes)}`,
      );
      console.log(
        `  ${entry.removed ? "REMOVED" : entry.decision.toUpperCase()}: ${entry.reasons.join("; ")}`,
      );
    }
    const summary = report.summary;
    console.log(
      `\n${summary.worktrees} worktrees (${bytes(summary.worktreeBytes)}), ${summary.branches} local branches`,
    );
    console.log(
      `Eligible: ${summary.removableWorktrees} worktrees (${bytes(summary.removableBytes)}), ${summary.removableBranches} branches`,
    );
    console.log(
      `Removed: ${summary.removedWorktrees} worktrees, ${summary.removedBranches} branches; space reclaimed: ${bytes(summary.reclaimedBytes)}`,
    );
    console.log(
      report.dryRun
        ? `worktree-cleanup: plan ${report.plan?.id}; ${summary.removableWorktrees + summary.removableBranches} entries; ${report.plan?.path}`
        : `worktree-cleanup: applied plan ${report.plan?.id}; removed ${summary.removedWorktrees} worktrees, ${summary.removedBranches} branches`,
    );
    for (const error of report.errors) console.error(`Safety check: ${error}`);
  }
  if (report.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
