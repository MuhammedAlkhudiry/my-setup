// Blocks once until a condition holds or a timeout passes, so agents wait with one command instead of sleep-and-check loops.

import { existsSync } from "node:fs";
import { connect } from "node:net";

export type WaitKind = "file" | "port" | "pid" | "url" | "cmd";

export type WaitCondition = { kind: WaitKind; target: string; argv?: string[] };

/** One check: whether the condition holds, and what it saw when it does not; no detail when the deadline cut it off. */
type Attempt = { met: boolean; detail?: string };

export const WAIT_KINDS: Record<WaitKind, string> = {
  file: "file <path>          the path exists",
  port: "port [host:]<port>   a TCP connection succeeds (host defaults to 127.0.0.1)",
  pid: "pid <pid>            the process has exited",
  url: "url <url>            an HTTP request returns 2xx or 3xx",
  cmd: "cmd <command...>     the command exits 0 (one argument runs through sh -c)",
};

/** Parses `<kind> <target...>` into a condition, or throws with the usage problem. */
export function parseCondition(args: string[]): WaitCondition {
  const [kind, ...rest] = args;
  if (!kind || !(kind in WAIT_KINDS)) throw new Error(`unknown condition ${kind ?? "(none)"}`);
  if (!rest.length) throw new Error(`${kind} needs a target`);
  if (kind === "cmd") {
    const argv = rest.length === 1 ? ["/bin/sh", "-c", rest[0]!] : rest;
    return { kind, target: rest.join(" "), argv };
  }
  if (rest.length > 1) throw new Error(`${kind} takes one target`);

  const target = rest[0]!;
  if (kind === "pid" && !/^\d+$/.test(target)) throw new Error(`pid must be a number: ${target}`);
  if (kind === "port" && !/^(.+:)?\d+$/.test(target)) throw new Error(`port must be [host:]<port>: ${target}`);
  if (kind === "url" && !/^https?:\/\//.test(target)) throw new Error(`url must start with http:// or https://: ${target}`);
  return { kind: kind as WaitKind, target };
}

function portOpen(target: string, timeoutMs: number): Promise<Attempt> {
  const split = target.lastIndexOf(":");
  const host = split < 0 ? "127.0.0.1" : target.slice(0, split);
  const port = Number(target.slice(split + 1));
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (attempt: Attempt) => {
      socket.destroy();
      resolve(attempt);
    };
    socket.once("connect", () => done({ met: true }));
    socket.once("timeout", () => done({ met: false, detail: "connect timed out" }));
    socket.once("error", (error) => done({ met: false, detail: error.message }));
  });
}

function processGone(pid: number): Attempt {
  try {
    process.kill(pid, 0);
    return { met: false, detail: `process ${pid} is running` };
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? { met: true } : { met: false, detail: `process ${pid} is running` };
  }
}

async function urlReady(url: string, timeoutMs: number): Promise<Attempt> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.status < 400 ? { met: true } : { met: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { met: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function commandSucceeds(argv: string[], timeoutMs: number): Promise<Attempt> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code === 0) return { met: true };
  return child.signalCode ? { met: false } : { met: false, detail: `exit ${code}\n${stdout}${stderr}`.trimEnd() };
}

/** Runs one check, giving it no longer than the time left. */
export function check(condition: WaitCondition, timeoutMs: number): Promise<Attempt> | Attempt {
  const budget = Math.max(timeoutMs, 1);
  switch (condition.kind) {
    case "file":
      return existsSync(condition.target) ? { met: true } : { met: false, detail: "missing" };
    case "port":
      return portOpen(condition.target, budget);
    case "pid":
      return processGone(Number(condition.target));
    case "url":
      return urlReady(condition.target, budget);
    case "cmd":
      return commandSucceeds(condition.argv!, budget);
  }
}

export type WaitResult = {
  condition: WaitKind;
  target: string;
  status: "met" | "timed-out";
  elapsedSeconds: number;
  attempts: number;
  last?: string;
};

/** Checks every interval until the condition holds or the timeout passes. */
export async function waitFor(
  condition: WaitCondition,
  options: { timeoutSeconds: number; intervalSeconds: number; signal?: AbortSignal },
): Promise<WaitResult> {
  const started = Date.now();
  const deadline = started + options.timeoutSeconds * 1000;
  let attempts = 0;
  let last: string | undefined;

  while (!options.signal?.aborted) {
    attempts++;
    const attempt = await check(condition, deadline - Date.now());
    // A check the deadline cut off says less than the full attempt before it.
    last = attempt.detail ?? last ?? "still running at the timeout";
    const elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
    if (attempt.met) return { condition: condition.kind, target: condition.target, status: "met", elapsedSeconds, attempts };

    const pause = Math.min(options.intervalSeconds * 1000, deadline - Date.now());
    if (pause <= 0) break;
    await Bun.sleep(pause);
  }

  const elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
  return { condition: condition.kind, target: condition.target, status: "timed-out", elapsedSeconds, attempts, last };
}
