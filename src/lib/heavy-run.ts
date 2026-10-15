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
  watch,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  claimHostCapacity,
  reapHostCapacity,
  releaseHostCapacity,
  type HeavyClass,
  type HostJob,
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
import { heavyRequester } from "./heavy-requester";

export const LEGACY_HEAVY_LOCK = "/tmp/agents-heavy.lock";
const HISTORY_RUNS = 2000;
const workerPath = fileURLToPath(new URL("../commands/heavy-run-worker.ts", import.meta.url));

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

async function waitForQueueChange(
  directory: string,
  legacyLockPath: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;

  await new Promise<void>((resolve) => {
    const watchers = [
      watch(directory, (_event, name) => {
        if (name === "state.json") finish();
      }),
      watch(dirname(legacyLockPath), (_event, name) => {
        if (name === basename(legacyLockPath)) finish();
      }),
    ];
    const timer = setTimeout(finish, timeout);
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      for (const watcher of watchers) watcher.close();
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
  exitCode: 0 | 1 | 75;
  resourceBudget: { resource: "host-capacity"; capacity: 1 };
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
  queuedAt: string;
  acquiredAt: string | null;
  waitedSeconds: number;
  ranSeconds: number;
  status: HeavyReceipt["status"];
  childExitCode: number | null;
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

export async function runHeavyCommand(options: HeavyOptions): Promise<HeavyReceipt> {
  const directory = options.directory ?? queueDirectory();
  const legacyLockPath = options.legacyLockPath ?? LEGACY_HEAVY_LOCK;
  const holder = (await processSnapshot()).find((row) => row.pid === process.pid);
  if (!holder) throw new Error("Cannot identify the heavy-run holder");
  const logDirectory = mkdtempSync(join(tmpdir(), "heavy-run-"));
  chmodSync(logDirectory, 0o700);
  const log = join(logDirectory, "full.log");
  const legacyTarget = join(logDirectory, "legacy-lock");
  const logFd = openSync(log, "w", 0o600);
  const queuedAt = Date.now();
  const deadline = queuedAt + options.waitSeconds * 1000;
  const job: HostJob = {
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
    while (true) {
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
      const granted = await withProcessState(
        (state, rows, observed) => {
          if (cancelled() || (options.waitSeconds > 0 && Date.now() >= deadline)) return false;
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
      if (granted) break;
      if (Date.now() >= deadline) {
        expired = true;
        status = "timed-out";
        break;
      }

      // Waiting is owned by this command, never by repeated agent tool calls.
      await waitForQueueChange(
        directory,
        legacyLockPath,
        Math.min(1000, Math.max(1, deadline - Date.now())),
        options.signal,
      );
    }

    if (!expired && !cancelled() && job.acquiredAt !== null) {
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
      await withProcessState(
        (state, rows) => {
          const identity = rows.find((row) => row.pid === worker!.pid);
          if (!identity || identity.pgid !== identity.pid)
            throw new Error("Cannot identify the heavy command process group");
          if (state.host.active?.reservationId !== job.reservationId)
            throw new Error("Host reservation was lost before startup");

          job.processGroup = identity;
          state.host.active.processGroup = identity;
          writeLegacyOwner(legacyTarget, job);
        },
        directory,
        legacyLockPath,
      );
      worker.stdin!.end(cancelled() ? undefined : JSON.stringify({ argv: options.argv }));
      if (cancelled()) await terminate();
      await workerExited;

      childExitCode = workerResult?.exitCode ?? null;
      childSignal = workerResult?.signal ?? null;
      error = workerResult?.error ?? error;
      status = cancelled() ? "cancelled" : childExitCode === 0 ? "succeeded" : "failed";
      if (!workerResult && !cancelled())
        error ??= "Heavy command process group exited without a child result";
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
    worker?.stdin?.end();
    await terminate();
    if (workerExited) await workerExited;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    closeSync(logFd);
    await withProcessState(
      (state, rows) => {
        // Preserve a crashed supervisor's surviving group. The next caller/status
        // reaps it only once process identity proves that the group is gone.
        if (!job.processGroup || !groupIsAlive(job.processGroup, rows)) {
          releaseHostCapacity(state, job.reservationId);
          releaseLegacyLock(legacyLockPath, legacyTarget);
        }
      },
      directory,
      legacyLockPath,
    );

    // History IO and compaction never hold the transaction lock.
    try {
      const now = Date.now();
      recordRun(directory, {
        finishedAt: new Date(now).toISOString(),
        owner: job.owner,
        class: job.class,
        cwd: process.cwd(),
        command: job.argv.join(" ").slice(0, 300),
        queuedAt: new Date(job.queuedAt).toISOString(),
        acquiredAt: job.acquiredAt === null ? null : new Date(job.acquiredAt).toISOString(),
        waitedSeconds: Math.round(((job.acquiredAt ?? now) - job.queuedAt) / 1000),
        ranSeconds: job.acquiredAt === null ? 0 : Math.round((now - job.acquiredAt) / 1000),
        status,
        childExitCode,
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
    exitCode: expired ? 75 : success ? 0 : 1,
    resourceBudget: { resource: "host-capacity", capacity: 1 },
    log: success ? null : log,
    ...(error ? { error } : {}),
  };
}
