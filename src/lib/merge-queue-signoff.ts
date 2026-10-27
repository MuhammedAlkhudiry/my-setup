import { readFile } from "node:fs/promises";
import { loadavg } from "node:os";
import {
  acquireQueueLock,
  QueueEnvironmentError,
  type CandidateRun,
} from "./merge-queue";

export function signoffPolicy(env = process.env) {
  // Owner chose 60 (2026-10-21): a busy Mac running simulators still merges; one retry absorbs slow false failures.
  const maxLoad = Number(env.MERGE_QUEUE_MAX_LOAD ?? 60);
  const waitSeconds = Number(env.MERGE_QUEUE_WAIT_SECONDS ?? 3600);
  if (
    !Number.isFinite(maxLoad) ||
    maxLoad <= 0 ||
    !Number.isFinite(waitSeconds) ||
    waitSeconds <= 0
  )
    throw new QueueEnvironmentError(
      "environment broken: invalid merge queue load/wait configuration",
    );

  return { maxLoad, waitSeconds };
}

interface AdmissionOptions {
  maxLoad: number;
  waitSeconds: number;
  readLoad?: () => number;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  lock?: () => (() => void) | undefined;
  log: (line: string) => Promise<void>;
}

/** The worker owns this bounded wait; it consumes no heavy-run reservation. */
export async function admitSignoff(options: AdmissionOptions) {
  const now = options.now ?? Date.now;
  const readLoad = options.readLoad ?? (() => loadavg()[0]!);
  const pause =
    options.pause ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.waitSeconds * 1000;
  let release: (() => void) | undefined;
  const maxLoad = options.maxLoad;
  let announced = false;
  try {
    while (true) {
      release ??= (options.lock ?? (() => acquireQueueLock("signoff")))();
      const load = readLoad();
      if (release && load < maxLoad) return { load, release };
      if (now() >= deadline)
        throw new QueueEnvironmentError(
          `environment broken: sign-off admission timed out (load ${load.toFixed(2)}, requires < ${maxLoad}; wait ${options.waitSeconds}s)`,
        );
      if (!announced) {
        await options.log(
          `sign-off waiting: ${release ? `load ${load.toFixed(2)} requires < ${maxLoad}` : "another queue sign-off is active"}; deadline ${new Date(deadline).toISOString()}`,
        );
        announced = true;
      }

      await pause(Math.min(5000, Math.max(1, deadline - now())));
    }
  } catch (error) {
    release?.();
    throw error;
  }
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const transientFailure =
  /timed?\s*out|timeout|test timing regression|slow[- ]test|slow PHP test|budget.{0,40}(?:exceed|fail)/i;

export async function signoffDiagnostics(
  output: string,
  fallbackLog: string,
  readLog = (path: string) => readFile(path, "utf8"),
) {
  const cache = new Map<string, string>();
  const expand = async (text: string, depth = 0): Promise<string> => {
    text = stripAnsi(text);
    if (depth >= 8 || cache.size >= 64) return text;
    const paths = [...text.matchAll(/\blog(?:=|:\s*)(\/[^\s;]+)/g)].map(
      (match) => match[1]!,
    );
    for (const path of new Set(paths)) {
      if (cache.has(path)) continue;
      cache.set(path, "");
      const content = await readLog(path).catch(
        () => `Log unavailable: ${path}`,
      );
      cache.set(path, content);
      text += `\n${await expand(content, depth + 1)}`;
    }
    return text;
  };
  const expanded = await expand(output);
  const stages = [...expanded.matchAll(/^FAIL\s+(\S+)\s+log=(\S+)/gm)];
  const failures: CandidateRun["failures"] = [];
  for (const match of stages.length ? stages : [["", "signoff", fallbackLog]]) {
    const name = match[1]!;
    const log = match[2]!;
    if (
      failures.some((failure) => failure.name === name && failure.log === log)
    )
      continue;
    // Expand this stage independently so unrelated passing/failing stages do not obscure its cause.
    const stageCache = new Set<string>();
    const stageText = async (text: string, depth = 0): Promise<string> => {
      text = stripAnsi(text);
      if (depth >= 8) return text;
      for (const reference of text.matchAll(/\blog(?:=|:\s*)(\/[^\s;]+)/g)) {
        const path = reference[1]!;
        if (stageCache.has(path)) continue;
        stageCache.add(path);
        text += `\n${await stageText(cache.get(path) ?? (await readLog(path).catch(() => "")), depth + 1)}`;
      }
      return text;
    };
    const text = await stageText(
      cache.get(log) ?? (await readLog(log).catch(() => output)),
    );
    const reason =
      /test timing regression|slow[- ]test.{0,40}(?:exceed|budget)/i.test(text)
        ? "slow-test budget"
        : /coverage.{0,80}(?:below|fail|threshold|minimum)/i.test(text)
          ? "coverage gate"
          : /timed?\s*out|timeout/i.test(text)
            ? "timeout"
            : "check failure";
    const details = text
      .split("\n")
      .filter((line) =>
        /::error|Tests:|Test Suites:|timed?\s*out|timeout|test timing regression|coverage.{0,80}(?:below|fail|threshold|minimum)/i.test(
          line,
        ),
      )
      .slice(-12)
      .map((line) => line.slice(0, 800));
    failures.push({
      name,
      log,
      reason: `${reason}${details.length ? `: ${details.join("; ")}` : ""}`,
      // Every test passed and only the per-test timing budget tripped.
      budgetOnly:
        reason === "slow-test budget" &&
        /Tests:.*\bpassed\b/.test(text) &&
        !/Tests:.*\bfailed\b|\bFAILED\b|::error(?! title=PHP test timing regression)/.test(
          text,
        ),
    });
  }
  return {
    failures,
    transient: transientFailure.test(expanded),
    environmentBroken: /missing from PATH|command not found|\bENOENT\b/.test(
      expanded,
    ),
  };
}

export async function candidateSignoff(options: {
  run: (
    attempt: number,
  ) => Promise<{ ok: boolean; output: string; log?: string }>;
  requireClean: () => Promise<void>;
  log: (line: string) => Promise<void>;
  runLog: string;
  policy?: ReturnType<typeof signoffPolicy>;
  admission?: Partial<
    Omit<AdmissionOptions, "log" | "maxLoad" | "waitSeconds">
  >;
  readLog?: (path: string) => Promise<string>;
}) {
  const policy = options.policy ?? signoffPolicy();
  const readLoad = options.admission?.readLoad ?? (() => loadavg()[0]!);
  const runs: CandidateRun[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const admitted = await admitSignoff({
      ...policy,
      ...options.admission,
      log: options.log,
    });
    let result: Awaited<ReturnType<typeof options.run>>;
    let endLoad: number;
    try {
      await options.log(
        `sign-off run ${attempt} start: load=${admitted.load.toFixed(2)}, threshold=${policy.maxLoad}`,
      );
      result = await options.run(attempt);
    } finally {
      endLoad = readLoad();
      admitted.release();
      await options.log(
        `sign-off run ${attempt} end: load=${endLoad.toFixed(2)}`,
      );
    }
    await options.requireClean();
    const runLog = result.log ?? options.runLog;
    const diagnostics = result.ok
      ? { failures: [], transient: false, environmentBroken: false }
      : await signoffDiagnostics(result.output, runLog, options.readLog);
    const run: CandidateRun = {
      attempt,
      startLoad: admitted.load,
      endLoad,
      log: runLog,
      failures: diagnostics.failures,
    };
    runs.push(run);
    await options.log(`sign-off result: ${JSON.stringify(run)}`);
    if (diagnostics.environmentBroken)
      throw new QueueEnvironmentError(
        `environment broken: ${JSON.stringify(diagnostics.failures)}`,
      );
    if (result.ok) return { ok: true, runs };
    // A batch's timing noise is not attributable to any PR; agents' own sign-off still enforces the budget.
    if (
      diagnostics.failures.length &&
      diagnostics.failures.every((failure) => failure.budgetOnly)
    ) {
      run.warning = `slow-test budget only: ${diagnostics.failures.map((failure) => `${failure.name} log=${failure.log}`).join("; ")}`;
      await options.log(`Landing with warning: ${run.warning}`);
      return { ok: true, runs };
    }
    if (attempt === 2 || (!diagnostics.transient && endLoad < policy.maxLoad))
      return { ok: false, runs };
    await options.log(
      "Retrying the exact candidate once after load/timeout/budget failure",
    );
  }
  throw new Error("Unreachable sign-off attempt");
}
