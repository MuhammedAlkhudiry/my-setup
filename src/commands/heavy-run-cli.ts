#!/usr/bin/env bun

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heavyStatus, runHeavyCommand } from "../lib/heavy-run";
import type { HeavyClass } from "../lib/host-capacity";

const help = `Usage: heavy-run [--class checks|benchmark|build] [--wait <seconds>] [--owner <title>] [--json] [--verbose] -- <argv...>
       heavy-run status [--json] [--verbose]

One host slot shared with the device lease store. Class defaults to checks;
wait defaults to 540 seconds. Light work does not need a reservation.
Exit codes: 0 child succeeded, 1 failed/cancelled, 2 invalid input, 75 wait timeout.
JSON includes the child's original exit code and signal. Output is captured in a
private log; --verbose prints it. Nested heavy-run calls are rejected. Requesters
take turns, with FIFO jobs per session (or worktree when no session ID is set).
Existing pre-upgrade callers drain with their compatible ordering. Every finished
run is appended to heavy-run-history.jsonl in the queue's state directory.
status lists the active job and waiting jobs; --json returns their identities.
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
    let waitSeconds = 540;
    let owner = process.env.T3_THREAD_TITLE || `pid ${process.pid}`;
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
        const describe = (job: NonNullable<typeof receipt.active>) =>
          `${job.owner.replace(/\s+/g, " ")} (${job.class})`;
        console.log(
          `heavy-run: active ${receipt.active ? describe(receipt.active) : "none"}; waiting ${receipt.waiting.map(describe).join(", ") || "none"}${receipt.legacyBlocked && !receipt.active ? "; legacy lock held" : ""}`,
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
      validated = true;
      const receipt = await runHeavyCommand({
        argv,
        class: className,
        waitSeconds,
        owner,
        signal: abort.signal,
        ...(verbose ? { onOutput: (output: string) => process.stderr.write(output) } : {}),
      });
      if (json) console.log(JSON.stringify(receipt));
      else if (receipt.exitCode === 0) {
        const seconds = (from: string, to: string) =>
          Math.round((Date.parse(to) - Date.parse(from)) / 1000);
        console.log(
          `heavy-run: ok (waited ${seconds(receipt.queuedAt, receipt.acquiredAt!)}s, ran ${seconds(receipt.acquiredAt!, receipt.finishedAt)}s)`,
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
