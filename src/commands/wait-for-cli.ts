#!/usr/bin/env bun

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCondition, WAIT_KINDS, waitFor } from "../lib/wait-for";

const help = `Usage: wait-for [--timeout <seconds>] [--interval <seconds>] [--json] [--verbose] <condition>

Blocks once until the condition holds, instead of a sleep-and-check loop. Options go before the condition.
Conditions:
${Object.values(WAIT_KINDS)
  .map((line) => `  ${line}`)
  .join("\n")}
Timeout defaults to 110 seconds, under the agent Bash tool's default limit; raise both together. Interval defaults to 2.
If the job notifies on completion (a background command, a subagent, a PR watch), end the turn instead.
Exit codes: 0 condition met, 2 invalid input, 75 timed out, 130 interrupted.
Examples: wait-for port 3000; wait-for --timeout 300 cmd 'gh run view 123 --exit-status'; wait-for pid 4242`;

const args = process.argv.slice(2);
const options = { timeoutSeconds: 110, intervalSeconds: 2, json: false, verbose: false };
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => abort.abort());

function seconds(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${flag} needs a positive number of seconds`);
  return parsed;
}

try {
  if (!args.length || ["--help", "-h", "help"].includes(args[0]!)) {
    console.log(help);
    process.exit(args.length ? 0 : 2);
  }

  let index = 0;
  for (; index < args.length && args[index]!.startsWith("--"); index++) {
    const flag = args[index]!;
    if (flag === "--") {
      index++;
      break;
    }
    if (flag === "--json") options.json = true;
    else if (flag === "--verbose") options.verbose = true;
    else if (flag === "--timeout") options.timeoutSeconds = seconds(flag, args[++index]);
    else if (flag === "--interval") options.intervalSeconds = seconds(flag, args[++index]);
    else throw new Error(`unknown option ${flag}`);
  }
  const condition = parseCondition(args.slice(index));

  const result = await waitFor(condition, { ...options, signal: abort.signal });
  const interrupted = result.status === "timed-out" && abort.signal.aborted;
  // Command output and long errors go to a private log so the failure line stays short.
  const log =
    result.last?.includes("\n") && !options.verbose
      ? join(mkdtempSync(join(tmpdir(), "wait-for-")), "last-attempt.log")
      : undefined;
  if (log) writeFileSync(log, `${result.last}\n`, { mode: 0o600 });

  if (options.json) {
    console.log(
      JSON.stringify({
        ...result,
        ...(interrupted ? { status: "interrupted" } : {}),
        ...(log ? { log } : {}),
      }),
    );
  } else if (result.status === "met") {
    console.log(
      `wait-for: ${condition.kind} ${condition.target} ready after ${result.elapsedSeconds}s`,
    );
  } else {
    const last = log ? `last attempt log: ${log}` : `last: ${result.last ?? "not met"}`;
    console.error(
      `wait-for: ${interrupted ? "interrupted" : "timed out"} after ${result.elapsedSeconds}s waiting for ${condition.kind} ${condition.target}; ${last}`,
    );
  }
  process.exitCode = result.status === "met" ? 0 : interrupted ? 130 : 75;
} catch (error) {
  console.error(
    `wait-for: ${error instanceof Error ? error.message : String(error)}; run wait-for --help`,
  );
  process.exitCode = 2;
}
