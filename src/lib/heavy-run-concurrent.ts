import { readMemoryPressure } from "./host-capacity";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareConcurrentTurns, CURRENT_HEAVY_CLIENT } from "./concurrent-turns";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { reapHostCapacity, type HostJob } from "./host-capacity";
import { recoverLegacyLock, releaseLegacyLock } from "./heavy-legacy-lock";
import { groupIsAlive, processSnapshot, type ProcessRow } from "./process-identity";
import { queueDirectory, readQueueState, withQueueState } from "./queue-store";
import type { QueueState } from "./device-queue";
import {
  claimConcurrentCapacity,
  reapConcurrentCapacity,
  releaseConcurrentCapacity,
  emptyConcurrentCapacity,
  HEAVY_CAPACITY,
  type ConcurrentCapacity,
} from "./concurrent-capacity";
import {
  runHeavyCommand as runScheduledCommand,
  LEGACY_HEAVY_LOCK,
  heavyCpuIdle,
  heavyLoadAdmission,
  type HeavyScheduler,
  type HeavyOptions,
} from "./heavy-run";
export { deferredHeavyCommand } from "./heavy-run";

function legacyVersion(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${stat.ino}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

// Serial clients retain state.json; concurrent leases use their own file. All
// admission, guard handoff, identity updates and release share state.lock.
// An aggregate marker has no holder/reservationId: serial recovery ignores it,
// and serial release only unlinks its own random target. Replacing the symlink
// under that same flock therefore keeps the next serial job out after the
// current one releases. Count that current serial job against capacity;
// never release the aggregate while concurrent work lives.
// v2 uses a distinct target so already-loaded concurrent-v1 cleanup cannot
// unlink a borrowed guard while a serial job is still running.
const concurrentPath = (directory: string) => join(directory, "heavy-concurrent.json");
const guardTarget = (directory: string) => join(directory, "heavy-concurrent-lock-v2");
const v1GuardTarget = (directory: string) => join(directory, "heavy-concurrent-lock");
const markerName = ".heavy-run-owner.json";

interface AggregateOwner {
  protocol: "heavy-concurrent-v2";
  legacyTarget?: string;
  legacyReservation?: string;
}

export function readConcurrentCapacity(directory: string): ConcurrentCapacity {
  try {
    return JSON.parse(readFileSync(concurrentPath(directory), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyConcurrentCapacity();
  }
}

function targetOf(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

function readOwner(
  target: string,
): Partial<HostJob & Omit<AggregateOwner, "protocol">> & { protocol?: string } {
  try {
    return JSON.parse(readFileSync(join(target, markerName), "utf8"));
  } catch {
    return {};
  } // Unknown ownership is fail-closed; never reclaim it.
}

function ownsGuard(directory: string, path: string): boolean {
  return targetOf(path) === guardTarget(directory);
}

function replaceGuard(path: string, target: string): void {
  const temporary = path + "." + crypto.randomUUID();
  try {
    symlinkSync(target, temporary, "dir");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function canShareGuard(directory: string, path: string, legacy: HostJob | null): boolean {
  const target = targetOf(path);
  if (!existsSync(path) && target === null) return !legacy;
  if (target === guardTarget(directory)) return true;
  if (target === v1GuardTarget(directory))
    return readOwner(target).protocol === "heavy-concurrent-v1" && !legacy;
  return !!target && !!legacy && readOwner(target).reservationId === legacy.reservationId;
}

// With no serial holder, retain the v1-compatible aggregate target. All old
// concurrent clients count this same active array and can acquire/release it.
function shareConcurrentGuard(directory: string, path: string): void {
  const target = v1GuardTarget(directory);
  if (targetOf(path) === target) return;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, markerName), JSON.stringify({ protocol: "heavy-concurrent-v1" }), {
    mode: 0o600,
  });
  if (ownsGuard(directory, path)) {
    replaceGuard(path, target);
    rmSync(guardTarget(directory), { recursive: true, force: true });
  } else symlinkSync(target, path, "dir");
}

function acquireGuard(directory: string, path: string, legacy: HostJob | null): void {
  if (!legacy) {
    shareConcurrentGuard(directory, path);
    return;
  }
  if (ownsGuard(directory, path)) return;
  const previous = targetOf(path);
  const target = guardTarget(directory);
  const owner: AggregateOwner = { protocol: "heavy-concurrent-v2" };
  if (legacy && previous) {
    owner.legacyTarget = previous;
    owner.legacyReservation = legacy.reservationId;
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, markerName), JSON.stringify(owner), { mode: 0o600 });
  // Existing state-aware serial clients also hold state.lock here. mkdir-only
  // callers are never adopted; when absent, symlink creation still uses EEXIST.
  if (previous) replaceGuard(path, target);
  else symlinkSync(target, path, "dir");
}

function releaseGuard(directory: string, path: string, legacy: HostJob | null): void {
  if (!ownsGuard(directory, path)) return;
  const target = guardTarget(directory);
  const owner = readOwner(target);
  if (legacy) {
    // Returning the original target lets its holder finish/release normally,
    // even if no new client remains to poll. Never replace unknown ownership.
    if (
      owner.legacyReservation !== legacy.reservationId ||
      !owner.legacyTarget ||
      readOwner(owner.legacyTarget).reservationId !== legacy.reservationId
    )
      return;
    replaceGuard(path, owner.legacyTarget);
    rmSync(target, { recursive: true, force: true });
  } else releaseLegacyLock(path, target);
}

interface ConcurrentState {
  host: ConcurrentCapacity;
  legacy: QueueState;
}

function legacyAdmissionBlocked(state: ConcurrentState, directory: string, path: string): boolean {
  const legacy = state.legacy.host.active;
  return (
    (!legacy &&
      state.legacy.host.waiting.length > 0 &&
      !!state.host.legacyBackfill &&
      !state.host.legacyBackfill.anchors.some((id) =>
        state.host.active.some((job) => job.reservationId === id),
      )) ||
    !canShareGuard(directory, path, legacy)
  );
}

export async function withConcurrentProcessState<T>(
  fn: (
    state: ConcurrentState,
    rows: ProcessRow[],
    observed: HostJob[],
  ) => T & (T extends PromiseLike<unknown> ? never : unknown),
  directory: string,
  legacyLockPath: string,
  snapshot = processSnapshot,
): Promise<T> {
  while (true) {
    const host = readConcurrentCapacity(directory);
    const legacy = readQueueState(directory).host;
    const version = legacyVersion(legacyLockPath);
    const rows = await snapshot();
    const result = await withQueueState((state) => {
      const current = readConcurrentCapacity(directory);
      if (
        JSON.stringify(current.active) !== JSON.stringify(host.active) ||
        JSON.stringify(state.host.active) !== JSON.stringify(legacy.active) ||
        legacyVersion(legacyLockPath) !== version
      )
        return { retry: true } as const;

      current.capacity = HEAVY_CAPACITY;
      recoverLegacyLock(legacyLockPath, rows, state.host.active);
      reapHostCapacity(state, rows, legacy.waiting);
      reapConcurrentCapacity(current, rows, host.waiting);
      prepareConcurrentTurns(
        current,
        state.host.active ? [state.host.active] : [],
        state.host.waiting,
      );
      if (!state.host.active && ownsGuard(directory, legacyLockPath))
        shareConcurrentGuard(directory, legacyLockPath);
      const value = fn({ host: current, legacy: state }, rows, host.waiting);
      const path = concurrentPath(directory);
      const temporary = path + "." + process.pid + ".tmp";
      try {
        const next = JSON.stringify(current);
        if (!existsSync(path) || readFileSync(path, "utf8") !== next) {
          writeFileSync(temporary, next, { mode: 0o600 });
          renameSync(temporary, path);
        }
      } finally {
        rmSync(temporary, { force: true });
      }
      // Cleanup only after the last release is durable. A crash before this
      // point leaves a guard that the next new caller/status safely recovers.
      if (!current.active.length) {
        releaseGuard(directory, legacyLockPath, state.host.active);
        if (
          !state.host.active &&
          targetOf(legacyLockPath) === v1GuardTarget(directory) &&
          readOwner(v1GuardTarget(directory)).protocol === "heavy-concurrent-v1"
        )
          releaseLegacyLock(legacyLockPath, v1GuardTarget(directory));
      }
      return { retry: false, value } as const;
    }, directory);
    if (!result.retry) return result.value;
  }
}

const scheduler: HeavyScheduler = {
  capacity: HEAVY_CAPACITY,
  express: true,
  async acquire(
    job,
    { directory, legacyLockPath, readLoad, readPressure, readCpuIdle },
    cancelled,
  ) {
    const memoryPressure = (readPressure ?? readMemoryPressure)();
    const cpuIdle = heavyCpuIdle(readLoad, readCpuIdle);
    return withConcurrentProcessState(
      (state) => {
        if (cancelled()) return false;
        Object.assign(job, { clientVersion: CURRENT_HEAVY_CLIENT });
        const legacy = state.legacy.host.active;
        // Share serial checks/build immediately. After it ends, bounded
        // backfill drains when the original concurrent anchors finish.
        const blocked = legacyAdmissionBlocked(state, directory, legacyLockPath);
        const previous = structuredClone(state.host);
        if (
          !claimConcurrentCapacity(
            state.host,
            job,
            Date.now(),
            blocked,
            legacy ? [legacy] : [],
            state.legacy.host.waiting,
            (ticket, active) =>
              !heavyLoadAdmission(
                ticket,
                active,
                Date.now(),
                readLoad,
                () => memoryPressure,
                () => cpuIdle,
              ).held,
          )
        )
          return false;
        try {
          acquireGuard(directory, legacyLockPath, legacy);
        } catch (error) {
          Object.assign(state.host, previous);
          job.acquiredAt = null;
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return false;
        }
        return true;
      },
      directory,
      legacyLockPath,
    );
  },
  async start(job, { directory, legacyLockPath }, pid) {
    await withConcurrentProcessState(
      (state, rows) => {
        const identity = rows.find((row) => row.pid === pid);
        if (!identity || identity.pgid !== identity.pid)
          throw new Error("Cannot identify the heavy command process group");
        const ticket = state.host.active.find(
          (ticket) => ticket.reservationId === job.reservationId,
        );
        if (!ticket) throw new Error("Host reservation was lost before startup");
        job.processGroup = identity;
        ticket.processGroup = identity;
      },
      directory,
      legacyLockPath,
    );
  },
  async release(job, { directory, legacyLockPath }) {
    await withConcurrentProcessState(
      (state, rows) => {
        if (!job.processGroup || !groupIsAlive(job.processGroup, rows))
          releaseConcurrentCapacity(state.host, job.reservationId);
      },
      directory,
      legacyLockPath,
    );
  },
};

export function startCompatibilityDispatcher(directory: string, legacyLockPath: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const logFd = openSync(join(directory, "heavy-dispatcher.log"), "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        "--no-env-file",
        fileURLToPath(new URL("../commands/heavy-run-dispatcher.ts", import.meta.url)),
        directory,
        legacyLockPath,
      ],
      { detached: true, stdio: ["ignore", logFd, logFd] },
    );
    child.on("error", () => {});
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

/** Metadata only: never starts, stops, or grants another process's job. */
export async function dispatchCompatibilityQueue(
  directory: string,
  legacyLockPath: string,
): Promise<boolean> {
  const host = readConcurrentCapacity(directory);
  const legacy = readQueueState(directory).host;
  const older = (job: (typeof host.active)[number]) => job.clientVersion !== CURRENT_HEAVY_CLIENT;
  if (!legacy.active && !legacy.waiting.length && ![...host.active, ...host.waiting].some(older))
    return false;
  return withConcurrentProcessState(
    (state) =>
      !!state.legacy.host.active ||
      state.legacy.host.waiting.length > 0 ||
      [...state.host.active, ...state.host.waiting].some(older),
    directory,
    legacyLockPath,
  );
}

export const runHeavyCommand = (options: HeavyOptions) => {
  if (!options.directory)
    startCompatibilityDispatcher(
      options.directory ?? queueDirectory(),
      options.legacyLockPath ?? LEGACY_HEAVY_LOCK,
    );
  return runScheduledCommand(options, scheduler);
};

export async function heavyStatus(
  directory = queueDirectory(),
  legacyLockPath = LEGACY_HEAVY_LOCK,
  readLoad?: () => number,
  readPressure = readMemoryPressure,
  readCpuIdle?: () => number | undefined,
) {
  const memoryPressure = readPressure();
  const cpuIdle = heavyCpuIdle(readLoad, readCpuIdle);
  if (directory === queueDirectory() && legacyLockPath === LEGACY_HEAVY_LOCK)
    startCompatibilityDispatcher(directory, legacyLockPath);
  return withConcurrentProcessState(
    (state) => ({
      schemaVersion: 2,
      resourceBudget: { resource: "host-capacity", capacity: HEAVY_CAPACITY },
      active: [
        ...(state.legacy.host.active
          ? [{ ...state.legacy.host.active, protocol: "legacy" as const }]
          : []),
        ...state.host.active.map((job) => ({
          ...job,
          protocol: job.clientVersion ?? ("concurrent-v1" as const),
        })),
      ],
      waiting: [
        ...state.legacy.host.waiting.map((job) => ({ ...job, protocol: "legacy" as const })),
        ...state.host.waiting.map((job) => ({
          ...job,
          protocol: job.clientVersion ?? ("concurrent-v1" as const),
          loadAdmission: heavyLoadAdmission(
            job,
            [...state.host.active, ...(state.legacy.host.active ? [state.legacy.host.active] : [])],
            Date.now(),
            readLoad,
            () => memoryPressure,
            () => cpuIdle,
          ),
        })),
      ],
      express: {
        active: state.host.active.filter((job) => job.reservationMode === "express").length,
        rule: { runs: 10, medianUnderSeconds: 10, p90UnderSeconds: 30 },
      },
      legacyBlocked: legacyAdmissionBlocked(state, directory, legacyLockPath),
    }),
    directory,
    legacyLockPath,
  );
}
