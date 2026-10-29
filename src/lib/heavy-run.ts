import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  claimHostCapacity,
  reapHostCapacity,
  releaseHostCapacity,
  type HeavyClass,
  type HostJob,
  readCpuIdle,
  readMemoryPressure,
  type MemoryPressure,
} from "./host-capacity";
import {
  acquireLegacyLock,
  recoverLegacyLock,
  releaseLegacyLock,
  writeLegacyOwner,
} from "./heavy-legacy-lock";
import { groupIsAlive, processSnapshot, type ProcessRow } from "./process-identity";
import { queueDirectory, readQueueState, withQueueState } from "./queue-store";
import type { QueueState } from "./device-queue";
import { expressHeavyCommand, heavyProject, readHeavyHistory } from "./heavy-express";
import { heavyRequester } from "./heavy-requester";

export const LEGACY_HEAVY_LOCK = "/tmp/agents-heavy.lock";
// Keep the escape interval below the CLI's default nine-minute queue timeout.
export const HEAVY_LOAD_POLICY = {
  threshold: cpus().length * 6,
  minCpuIdle: 10,
  maxWaitMs: 5 * 60_000,
};

const readLoadAverage = () => loadavg()[0]!;

/** Samples CPU idle outside the queue lock, and only when load is high enough to need it. */
export function heavyCpuIdle(readLoad = readLoadAverage, readIdle = readCpuIdle) {
  return readLoad() > HEAVY_LOAD_POLICY.threshold ? readIdle() : undefined;
}

/** Admission only: overdue jobs drain singly while responsiveness is at risk. */
export function heavyLoadAdmission(
  job: HostJob,
  active: HostJob[],
  now: number,
  readLoad = readLoadAverage,
  readPressure: () => MemoryPressure = readMemoryPressure,
  readIdle: () => number | undefined = readCpuIdle,
) {
  const load = readLoad();
  const memoryPressure = readPressure();
  // macOS load also counts processes stuck in I/O or idle wait, so it holds only on a busy CPU.
  const cpuIdle = load > HEAVY_LOAD_POLICY.threshold ? readIdle() : undefined;
  const cpuBusy = cpuIdle !== undefined && cpuIdle < HEAVY_LOAD_POLICY.minCpuIdle;
  const overloaded = memoryPressure === "critical" || cpuBusy;
  const held =
    overloaded && (now - job.queuedAt < HEAVY_LOAD_POLICY.maxWaitMs || active.length > 0);

  return { load, threshold: HEAVY_LOAD_POLICY.threshold, cpuIdle, memoryPressure, held };
}

export function describeLoadHold({
  load,
  threshold,
  cpuIdle,
  memoryPressure,
}: ReturnType<typeof heavyLoadAdmission>) {
  return [
    memoryPressure === "critical" && "critical memory pressure",
    cpuIdle !== undefined &&
      cpuIdle < HEAVY_LOAD_POLICY.minCpuIdle &&
      `load ${load.toFixed(1)} > ${threshold} with ${Math.round(cpuIdle)}% CPU idle`,
  ]
    .filter(Boolean)
    .join("; ");
}

const HISTORY_RUNS = 2000;
const workerPath = fileURLToPath(new URL("../commands/heavy-run-worker.ts", import.meta.url));
const cliPath = fileURLToPath(new URL("../commands/heavy-run-cli.ts", import.meta.url));

/** A project explicitly promises these runners reserve their own heavy steps. */
function declaredHeavyCommand(
  key: "deferredCommands" | "uncappedCommands",
  argv: string[],
  cwd: string,
): boolean {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return false;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Invalid heavy-run configuration: cannot read ${path}`);
  }
  const heavyRun = (config as { heavyRun?: unknown } | null)?.heavyRun;
  if (heavyRun === undefined) return false;
  const commands = (heavyRun as Record<string, unknown> | null)?.[key];
  if (
    typeof heavyRun === "object" &&
    heavyRun !== null &&
    !Array.isArray(heavyRun) &&
    commands === undefined
  )
    return false;
  if (
    typeof heavyRun !== "object" ||
    heavyRun === null ||
    Array.isArray(heavyRun) ||
    !Array.isArray(commands) ||
    commands.some(
      (command) =>
        !Array.isArray(command) ||
        !command.length ||
        command.some((arg) => typeof arg !== "string" || !arg.length || arg.includes("\0")),
    )
  )
    throw new Error(
      `Invalid heavy-run configuration: heavyRun.${key} must be an array of nonempty argv arrays containing nonempty strings`,
    );

  return commands.some((command: string[]) => command.every((arg, i) => argv[i] === arg));
}

export function deferredHeavyCommand(argv: string[], cwd = process.cwd()): boolean {
  return declaredHeavyCommand("deferredCommands", argv, cwd);
}

export function uncappedHeavyCommand(argv: string[], cwd = process.cwd()): boolean {
  return declaredHeavyCommand("uncappedCommands", argv, cwd) || deferredHeavyCommand(argv, cwd);
}

export const HEAVY_RUNTIME_LIMIT_MS = 90_000;

function legacyVersion(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${stat.ino}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

// ps can stall under host load. Never hold the flock while waiting for it. A
// changed active/legacy lock invalidates the snapshot (including new workers that
// did not exist when ps ran); retry without changing or re-enqueueing any ticket.
export async function withProcessState<T>(
  fn: (
    state: QueueState,
    rows: ProcessRow[],
    observed: HostJob[],
  ) => T & (T extends PromiseLike<unknown> ? never : unknown),
  directory: string,
  legacyLockPath: string,
  snapshot = processSnapshot,
): Promise<T> {
  while (true) {
    const host = readQueueState(directory).host;
    const legacy = legacyVersion(legacyLockPath);
    const rows = await snapshot();
    const result = await withQueueState((state) => {
      if (
        JSON.stringify(state.host.active) !== JSON.stringify(host.active) ||
        legacyVersion(legacyLockPath) !== legacy
      )
        return { retry: true } as const;

      return { retry: false, value: fn(state, rows, host.waiting) } as const;
    }, directory);
    if (!result.retry) return result.value;
  }
}

async function waitForCapacityRetry(
  timeout: number,
  signal?: AbortSignal,
  onWaiting?: () => void,
): Promise<void> {
  if (signal?.aborted) return;

  await new Promise<void>((resolve) => {
    // Bun's macOS fs.watch registration can stall under concurrent clients.
    // A bounded abortable timer never blocks enqueue notifications or the flock.
    const timer = setTimeout(finish, timeout);
    signal?.addEventListener("abort", finish, { once: true });
    onWaiting?.();

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export interface HeavyOptions {
  argv: string[];
  class: HeavyClass;
  waitSeconds: number;
  owner: string;
  requester?: string;
  signal?: AbortSignal;
  directory?: string;
  legacyLockPath?: string;
  onOutput?: (output: string) => void;
  onQueued?: () => void;
  /** Injectable retry wait; tests advance admission without the production polling delay. */
  waitForCapacityRetry?: typeof waitForCapacityRetry;
  /** Injectable host metric; never persisted in the shared queue. */
  readLoad?: () => number;
  readPressure?: () => MemoryPressure;
  readCpuIdle?: () => number | undefined;
  /** Only for explicitly opted-in runners that reserve each heavy step. */
  deferred?: boolean;
  /** Explicit cap for a non-deferred gate or build; ordinary checks cannot exceed their 90-second cap. */
  runtimeLimitSeconds?: number;
  /** Timer dependency for deterministic deadline tests; the production deadline is fixed. */
  scheduleRuntimeDeadline?: (expire: () => void, milliseconds: number) => () => void;
}

export interface HeavyReceipt {
  schemaVersion: 1;
  reservationId: string;
  status: "succeeded" | "failed" | "timed-out" | "cancelled";
  owner: string;
  class: HeavyClass;
  argv: string[];
  queuedAt: string;
  acquiredAt: string | null;
  finishedAt: string;
  processGroup: HostJob["processGroup"];
  childExitCode: number | null;
  childSignal: string | null;
  exitCode: 0 | 1 | 75 | 124;
  runtimeLimitSeconds: number | null;
  elapsedSeconds: number;
  resourceBudget: { resource: "host-capacity"; capacity: number };
  reservationMode: "eager" | "deferred" | "express";
  log: string | null;
  error?: string;
}

/** One finished run: who asked, where, how long it waited for the slot and ran, and how it ended. */
export interface HeavyHistoryEntry {
  finishedAt: string;
  owner: string;
  class: HeavyClass;
  cwd: string;
  command: string;
  /** Exact matching and shared Git directory; absent in older entries. */
  argv?: string[];
  project?: string | null;
  queuedAt: string;
  acquiredAt: string | null;
  waitedSeconds: number;
  ranSeconds: number;
  status: HeavyReceipt["status"];
  childExitCode: number | null;
  /** Absent in history written before deferred runners were supported. */
  reservationMode?: HeavyReceipt["reservationMode"];
}

/** Every finished run, newest last, so queue waits and run times can be read back; it keeps the last `HISTORY_RUNS` runs. */
export const heavyHistoryPath = (directory = queueDirectory()) =>
  join(directory, "heavy-run-history.jsonl");

function recordRun(directory: string, entry: HeavyHistoryEntry): void {
  const path = heavyHistoryPath(directory);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });

  if (statSync(path).size > 2_000_000) {
    const runs = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, `${runs.slice(-HISTORY_RUNS).join("\n")}\n`, { mode: 0o600 });
  }
}

export async function heavyStatus(
  directory = queueDirectory(),
  legacyLockPath = LEGACY_HEAVY_LOCK,
) {
  return withProcessState(
    (state, rows, observed) => {
      recoverLegacyLock(legacyLockPath, rows, state.host.active);
      reapHostCapacity(state, rows, observed);

      return {
        schemaVersion: 1,
        resourceBudget: { resource: "host-capacity", capacity: 1 },
        active: state.host.active,
        waiting: state.host.waiting,
        legacyBlocked: existsSync(legacyLockPath),
      };
    },
    directory,
    legacyLockPath,
  );
}

/** Internal scheduler boundary; the legacy implementation remains readable by loaded clients. */
export interface HeavyScheduler {
  capacity: number;
  express?: boolean;
  acquire(job: HostJob, context: HeavyContext, cancelled: () => boolean): Promise<boolean>;
  start(job: HostJob, context: HeavyContext, pid: number): Promise<void>;
  release(job: HostJob, context: HeavyContext): Promise<void>;
}

export interface HeavyContext {
  directory: string;
  legacyLockPath: string;
  legacyTarget: string;
  readLoad?: () => number;
  readPressure?: () => MemoryPressure;
  readCpuIdle?: () => number | undefined;
}

const legacyScheduler: HeavyScheduler = {
  capacity: 1,
  async acquire(job, { directory, legacyLockPath, legacyTarget }, cancelled) {
    return withProcessState(
      (state, rows, observed) => {
        if (cancelled()) return false;
        recoverLegacyLock(legacyLockPath, rows, state.host.active);
        reapHostCapacity(state, rows, observed);
        const requesters = state.host.requesters?.slice();
        if (!claimHostCapacity(state, job, Date.now(), existsSync(legacyLockPath))) return false;
        if (acquireLegacyLock(legacyLockPath, legacyTarget, job)) return true;

        state.host.active = null;
        job.acquiredAt = null;
        state.host.waiting.unshift(job);
        state.host.requesters = requesters;
        return false;
      },
      directory,
      legacyLockPath,
    );
  },
  async start(job, { directory, legacyLockPath, legacyTarget }, pid) {
    await withProcessState(
      (state, rows) => {
        const identity = rows.find((row) => row.pid === pid);
        if (!identity || identity.pgid !== identity.pid)
          throw new Error("Cannot identify the heavy command process group");
        if (state.host.active?.reservationId !== job.reservationId)
          throw new Error("Host reservation was lost before startup");
        job.processGroup = identity;
        state.host.active!.processGroup = identity;
        writeLegacyOwner(legacyTarget, job);
      },
      directory,
      legacyLockPath,
    );
  },
  async release(job, { directory, legacyLockPath, legacyTarget }) {
    await withProcessState(
      (state, rows) => {
        if (!job.processGroup || !groupIsAlive(job.processGroup, rows)) {
          releaseHostCapacity(state, job.reservationId);
          releaseLegacyLock(legacyLockPath, legacyTarget);
        }
      },
      directory,
      legacyLockPath,
    );
  },
};

export async function runHeavyCommand(
  options: HeavyOptions,
  scheduler: HeavyScheduler = legacyScheduler,
): Promise<HeavyReceipt> {
  const uncapped =
    options.class === "build" ||
    uncappedHeavyCommand(options.argv) ||
    process.env.HEAVY_RUN_UNCAPPED === "1";
  const requestedLimit = options.runtimeLimitSeconds;
  if (
    requestedLimit !== undefined &&
    (!Number.isFinite(requestedLimit) || requestedLimit <= 0 || requestedLimit > 3600)
  )
    throw new Error("Runtime limit must be between 1 and 3600 seconds");
  if (requestedLimit !== undefined && !uncapped && requestedLimit > 90)
    throw new Error("Ad-hoc checks and benchmarks cannot exceed 90 seconds");
  if (requestedLimit !== undefined && options.deferred)
    throw new Error("Deferred runners must cap their own heavy steps");
  const runtimeLimitSeconds = requestedLimit ?? (uncapped ? null : HEAVY_RUNTIME_LIMIT_MS / 1000);
  const directory = options.directory ?? queueDirectory();
  const legacyLockPath = options.legacyLockPath ?? LEGACY_HEAVY_LOCK;
  const holder = (await processSnapshot()).find((row) => row.pid === process.pid);
  if (!holder) throw new Error("Cannot identify the heavy-run holder");
  const logDirectory = mkdtempSync(join(tmpdir(), "heavy-run-"));
  chmodSync(logDirectory, 0o700);
  const log = join(logDirectory, "full.log");
  const legacyTarget = join(logDirectory, "legacy-lock");
  const context = {
    directory,
    legacyLockPath,
    legacyTarget,
    readLoad: options.readLoad,
    readPressure: options.readPressure,
    readCpuIdle: options.readCpuIdle,
  };
  const logFd = openSync(log, "w", 0o600);
  const queuedAt = Date.now();
  let runtimeExpired = false;
  let startedAt: number | undefined;
  let stopRuntimeTimer: (() => void) | undefined;
  const deadline = queuedAt + options.waitSeconds * 1000;
  const project = heavyProject(process.cwd());
  const express =
    !options.deferred &&
    scheduler.express === true &&
    expressHeavyCommand(
      readHeavyHistory(heavyHistoryPath(directory)),
      options.argv,
      options.class,
      project,
      queuedAt,
    );
  const reservationMode = options.deferred ? "deferred" : express ? "express" : "eager";
  const job: HostJob = {
    ...(express ? { reservationMode: "express" as const } : {}),
    reservationId: crypto.randomUUID(),
    sequence: 0,
    owner: options.owner,
    requester: options.requester ?? heavyRequester(),
    class: options.class,
    argv: options.argv,
    queuedAt,
    acquiredAt: null,
    holder,
    processGroup: null,
  };
  let status: HeavyReceipt["status"] = "failed";
  let childExitCode: number | null = null;
  let childSignal: string | null = null;
  let error: string | undefined;
  let expired = false;
  let attempted = false;
  let queued = false;
  let worker: ReturnType<typeof spawn> | undefined;
  let workerExited: Promise<void> | undefined;
  let workerFinished = false;
  const cancelled = () => options.signal?.aborted === true;
  const terminate = async () => {
    if (worker?.pid && job.processGroup && !workerFinished) {
      try {
        if (groupIsAlive(job.processGroup, await processSnapshot()))
          process.kill(-worker.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
  };
  const onAbort = () => {
    void terminate();
  };

  options.signal?.addEventListener("abort", onAbort);
  try {
    while (!options.deferred) {
      if (cancelled()) {
        status = "cancelled";
        break;
      }
      if (attempted && Date.now() >= deadline) {
        expired = true;
        status = "timed-out";
        break;
      }
      attempted = true;
      const granted = await scheduler.acquire(
        job,
        context,
        () => cancelled() || (options.waitSeconds > 0 && Date.now() >= deadline),
      );
      if (granted) break;
      if (Date.now() >= deadline) {
        expired = true;
        status = "timed-out";
        break;
      }

      // Waiting is owned by this command, never by repeated agent tool calls.
      await (options.waitForCapacityRetry ?? waitForCapacityRetry)(
        Math.min(1000, Math.max(1, deadline - Date.now())),
        options.signal,
        () => {
          if (queued) return;
          queued = true;
          options.onQueued?.();
        },
      );
    }

    if (cancelled()) status = "cancelled";
    if (!expired && !cancelled() && (options.deferred || job.acquiredAt !== null)) {
      // Without --no-env-file Bun loads the caller's .env, and the reserved command would inherit that project's dev settings.
      worker = spawn(process.execPath, ["--no-env-file", workerPath, job.reservationId], {
        detached: true,
        stdio: ["pipe", logFd, logFd, "pipe"],
      });
      let workerResult:
        | { exitCode: number | null; signal: string | null; error?: string }
        | undefined;
      let buffer = "";
      let readyResolve: () => void;
      let readyReject: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      (worker.stdio[3] as Readable).on("data", (data: Buffer) => {
        buffer += data.toString();
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (message.ready) readyResolve();
          else workerResult = message;
        }
      });
      worker.stdin!.on("error", () => {});
      workerExited = new Promise<void>((resolve) => {
        worker!.on("error", (failure) => {
          workerFinished = true;
          readyReject(failure);
          error = failure.message;
          resolve();
        });
        worker!.on("close", () => {
          workerFinished = true;
          readyReject(new Error("Heavy command supervisor exited before startup"));
          resolve();
        });
      });
      await ready;

      // The child cannot start until its process group has been recorded atomically.
      if (!options.deferred) await scheduler.start(job, context, worker!.pid!);
      else {
        const identity = (await processSnapshot()).find((row) => row.pid === worker!.pid);
        if (!identity || identity.pgid !== identity.pid)
          throw new Error("Cannot identify the heavy command process group");
        job.processGroup = identity;
      }
      worker.stdin!.end(
        cancelled()
          ? undefined
          : JSON.stringify({
              argv: options.argv,
              deferred: options.deferred === true,
              uncapped,
              cliPath,
              owner: options.owner,
              waitSeconds: options.waitSeconds,
            }),
      );
      startedAt = Date.now();
      if (runtimeLimitSeconds !== null) {
        const schedule =
          options.scheduleRuntimeDeadline ??
          ((expire, milliseconds) => {
            const timer = setTimeout(expire, milliseconds);
            return () => clearTimeout(timer);
          });
        stopRuntimeTimer = schedule(() => {
          runtimeExpired = true;
          try {
            process.kill(-worker!.pid!, "SIGKILL");
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure;
          }
        }, runtimeLimitSeconds * 1000);
      }
      if (cancelled()) await terminate();
      await workerExited;
      stopRuntimeTimer?.();

      childExitCode = workerResult?.exitCode ?? null;
      childSignal = workerResult?.signal ?? null;
      error = workerResult?.error ?? error;
      status = cancelled() ? "cancelled" : childExitCode === 0 ? "succeeded" : "failed";
      if (runtimeExpired) {
        status = "timed-out";
        childSignal = "SIGKILL";
        error = `${options.argv.join(" ")} ran over ${runtimeLimitSeconds}s (${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed) — make it faster`;
      }
      if (!workerResult && !cancelled())
        error ??= "Heavy command process group exited without a child result";
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
    worker?.stdin?.end();
    await terminate();
    if (workerExited) await workerExited;
  } finally {
    stopRuntimeTimer?.();
    options.signal?.removeEventListener("abort", onAbort);
    closeSync(logFd);
    // Keep a crashed supervisor's surviving group reserved until identity checks prove it is gone.
    if (!options.deferred) await scheduler.release(job, context);

    // History IO and compaction never hold the transaction lock.
    try {
      const now = Date.now();
      recordRun(directory, {
        finishedAt: new Date(now).toISOString(),
        owner: job.owner,
        class: job.class,
        cwd: process.cwd(),
        project,
        argv: job.argv,
        command: job.argv.join(" ").slice(0, 300),
        queuedAt: new Date(job.queuedAt).toISOString(),
        acquiredAt: job.acquiredAt === null ? null : new Date(job.acquiredAt).toISOString(),
        waitedSeconds: options.deferred
          ? 0
          : Math.round(((job.acquiredAt ?? now) - job.queuedAt) / 1000),
        ranSeconds: options.deferred
          ? Math.round((now - job.queuedAt) / 1000)
          : job.acquiredAt === null
            ? 0
            : Math.round((now - job.acquiredAt) / 1000),
        status,
        childExitCode,
        reservationMode,
      });
    } catch {
      /* Best effort. */
    }
  }

  if (error) writeFileSync(log, `${readFileSync(log, "utf8")}\n${error}\n`);
  options.onOutput?.(readFileSync(log, "utf8"));
  const success = status === "succeeded";
  if (success) rmSync(logDirectory, { recursive: true, force: true });

  return {
    schemaVersion: 1,
    reservationId: job.reservationId,
    status,
    owner: job.owner,
    class: job.class,
    argv: job.argv,
    queuedAt: new Date(job.queuedAt).toISOString(),
    acquiredAt: job.acquiredAt === null ? null : new Date(job.acquiredAt).toISOString(),
    finishedAt: new Date().toISOString(),
    processGroup: job.processGroup,
    childExitCode,
    childSignal,
    exitCode: runtimeExpired ? 124 : expired ? 75 : success ? 0 : 1,
    runtimeLimitSeconds,
    elapsedSeconds: startedAt === undefined ? 0 : (Date.now() - startedAt) / 1000,
    resourceBudget: { resource: "host-capacity", capacity: scheduler.capacity },
    reservationMode,
    log: success ? null : log,
    ...(error ? { error } : {}),
  };
}
