#!/usr/bin/env bun

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deferredHeavyCommand, heavyStatus, runHeavyCommand } from "../lib/heavy-run-concurrent";
import type { HeavyClass } from "../lib/host-capacity";

const help = `Usage: heavy-run [--class checks|benchmark|build] [--wait <seconds>] [--owner <title>] [--json] [--verbose] -- <argv...>
       heavy-run status [--json] [--verbose]

Up to ten checks/build/benchmark jobs share the host. Benchmark timings can be noisy; compare repeated runs or medians. Class defaults to checks;
wait defaults to 540 seconds. New jobs wait only for critical memory pressure or
1-minute load above six times the core count, with a five-minute starvation escape. Light work does not need a reservation.
Exit codes: 0 child succeeded, 1 failed/cancelled, 2 invalid input, 75 wait timeout, 124 runtime cap exceeded.
Checks and benchmarks are killed as a process group after 90 seconds: make it faster.
Builds and package.json heavyRun.deferredCommands or heavyRun.uncappedCommands (argv-prefix arrays) are exempt;
nested steps inherit HEAVY_RUN_UNCAPPED=1. There is no per-job cap override.
JSON includes runtimeLimitSeconds (90 or null), elapsedSeconds, status timed-out
and exitCode 124 for the runtime cap, plus the child's original exit code and signal. Output is captured in a
private log; --verbose prints it. Nested reservations are rejected. Projects may
opt cooperating runners in via package.json heavyRun.deferredCommands, an array
of argv-prefix arrays. They run without a slot and receive HEAVY_RUN_DEFERRED=1
and HEAVY_RUN_CLI (this Bun entrypoint); they must reserve each heavy step with
that CLI. Cache hits and cheap steps run directly. This opt-in is a promise that
every matching command, including its trailing arguments, cooperates. Undeclared
checks with ten recent matching runs (same argv and shared Git repository), median under 10s
and p90 under 30s, use tracked express leases without a slot. Other commands reserve eagerly.
Builds and benchmarks never use express. Requesters
take turns, with FIFO jobs per session (or worktree when no session ID is set).
A running pre-upgrade job can share the remaining slots with new jobs. Every finished
run is appended to heavy-run-history.jsonl in the queue's state directory.
status lists all active and waiting jobs; --json returns a version 2 receipt with active as an array.
The temporary mkdir lock is respected and held during execution. Commands must
keep descendants in their process group; escaped/daemonized children are not contained.`;
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const flags = separator < 0 ? args : args.slice(0, separator);
const argv = separator < 0 ? [] : args.slice(separator + 1);
const json = flags.includes("--json");
const verbose = flags.includes("--verbose");
const statusMode = flags[0] === "status";
let validated = false;
const abort = new AbortController();
const onSignal = () => abort.abort();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);

try {
  if (flags.length === 1 && ["--help", "-h"].includes(flags[0])) {
    console.log(help);
  } else {
    let className: HeavyClass = "checks";
    let waitSeconds = Number(process.env.HEAVY_RUN_WAIT_SECONDS ?? 540);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0)
      throw new Error("HEAVY_RUN_WAIT_SECONDS must be a finite nonnegative number");
    let owner = process.env.HEAVY_RUN_OWNER || process.env.T3_THREAD_TITLE || `pid ${process.pid}`;
    const seen = new Set<string>();

    for (let i = statusMode ? 1 : 0; i < flags.length; i++) {
      const flag = flags[i];
      if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
      seen.add(flag);
      if (flag === "--json" || flag === "--verbose") continue;
      if (!statusMode && ["--class", "--wait", "--owner"].includes(flag)) {
        const value = flags[++i];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
        if (flag === "--class") {
          if (!["checks", "benchmark", "build"].includes(value))
            throw new Error("Class must be checks, benchmark, or build");
          className = value as HeavyClass;
        } else if (flag === "--wait") {
          waitSeconds = Number(value);
          if (!Number.isFinite(waitSeconds) || waitSeconds < 0)
            throw new Error("Wait must be a finite nonnegative number of seconds");
        } else {
          if (!value.trim()) throw new Error("Owner must be a nonempty thread title");
          owner = value;
        }
      } else throw new Error(`Unknown option: ${flag}`);
    }

    if (statusMode) {
      if (separator >= 0) throw new Error("Status takes no child command");
      validated = true;
      const receipt = await heavyStatus();
      if (json) console.log(JSON.stringify(receipt));
      else {
        const describe = (job: (typeof receipt.active)[number]) =>
          `${job.owner.replace(/\s+/g, " ")} (${job.class}; ${job.reservationMode ?? "eager"}; ${job.protocol})`;
        console.log(
          `heavy-run: active ${receipt.active.map(describe).join(", ") || "none"}; waiting ${receipt.waiting.map(describe).join(", ") || "none"}${receipt.waiting.some((job) => "loadAdmission" in job && job.loadAdmission.held) ? "; held for responsiveness" : ""}${receipt.legacyBlocked && !receipt.active.length ? "; legacy lock held" : ""}`,
        );
        if (verbose) console.log(JSON.stringify(receipt, null, 2));
      }
    } else {
      if (!argv.length || argv.some((arg) => arg.includes("\0")))
        throw new Error("Pass -- followed by a command and its arguments");
      if (process.env.HEAVY_RUN_RESERVATION_ID)
        throw new Error(
          "Nested heavy-run would wait for its own host slot; wrap only the outer command",
        );
      const deferred = deferredHeavyCommand(argv);
      validated = true;
      const receipt = await runHeavyCommand({
        argv,
        class: className,
        waitSeconds,
        owner,
        signal: abort.signal,
        deferred,
        ...(verbose ? { onOutput: (output: string) => process.stderr.write(output) } : {}),
      });
      if (json) console.log(JSON.stringify(receipt));
      else if (receipt.exitCode === 0) {
        const seconds = (from: string, to: string) =>
          Math.round((Date.parse(to) - Date.parse(from)) / 1000);
        console.log(
          receipt.reservationMode === "deferred"
            ? "heavy-run: ok (deferred to heavy steps)"
            : `heavy-run: ok${receipt.reservationMode === "express" ? " (express)" : ""} (waited ${seconds(receipt.queuedAt, receipt.acquiredAt!)}s, ran ${seconds(receipt.acquiredAt!, receipt.finishedAt)}s)`,
        );
      } else
        console.error(
          `heavy-run: ${receipt.status}${receipt.childExitCode !== null ? ` (child exit ${receipt.childExitCode})` : ""}${receipt.error ? `; ${receipt.error.replace(/\s+/g, " ")}` : ""}; log: ${receipt.log}`,
        );
      process.exitCode = receipt.exitCode;
    }
  }
} catch (failure) {
  const error = failure instanceof Error ? failure.message : String(failure);
  const log = join(mkdtempSync(join(tmpdir(), "heavy-run-error-")), "full.log");
  writeFileSync(log, `${error}\n`, { mode: 0o600 });
  const exitCode = validated ? 1 : 2;
  if (json)
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        status: validated ? "failed" : "invalid-input",
        exitCode,
        error,
        log,
      }),
    );
  else console.error(`heavy-run: ${error.replace(/\s+/g, " ")}; log: ${log}`);
  process.exitCode = exitCode;
} finally {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, onSignal);
}
