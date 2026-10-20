import { spawnSync } from "node:child_process";
import type { QueueState } from "./device-queue";
import {
  groupIsAlive,
  matchesProcess,
  type ProcessIdentity,
  type ProcessRow,
} from "./process-identity";

export type HeavyClass = "checks" | "benchmark" | "build";

export type MemoryPressure = "normal" | "warning" | "critical" | "unknown";

export function parseMemoryPressure(level: string, report = ""): MemoryPressure {
  const known = ({ "1": "normal", "2": "warning", "4": "critical" } as const)[
    level.trim() as "1" | "2" | "4"
  ];
  if (known) return known;
  const state = report
    .match(
      /(?:memory pressure(?: level| state)?|system-wide memory pressure)\s*[:=]\s*(normal|warn(?:ing)?|critical)\b/i,
    )?.[1]
    ?.toLowerCase();
  return state === "warn" ? "warning" : ((state as MemoryPressure | undefined) ?? "unknown");
}

/** Bounded probes run outside the queue lock; unavailable metrics never stall admission. */
export function readMemoryPressure(): MemoryPressure {
  if (process.platform !== "darwin") return "unknown";
  const probe = (command: string, args: string[]) =>
    spawnSync(command, args, { encoding: "utf8", timeout: 1000 }).stdout ?? "";
  const level = probe("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
  const known = parseMemoryPressure(level);
  return known === "unknown"
    ? parseMemoryPressure(level, probe("/usr/bin/memory_pressure", []))
    : known;
}

export interface HostJob {
  reservationId: string;
  sequence: number;
  owner: string;
  /** Absent on tickets owned by already-running pre-upgrade callers. */
  requester?: string;
  class: HeavyClass;
  argv: string[];
  /** Tracked for load admission and process cleanup, without consuming a capacity slot. */
  reservationMode?: "express";
  queuedAt: number;
  acquiredAt: number | null;
  holder: ProcessIdentity;
  processGroup: ProcessIdentity | null;
}

export interface HostCapacity {
  resource: "host-capacity";
  capacity: 1;
  nextSequence: number;
  active: HostJob | null;
  waiting: HostJob[];
  /** Rotation order; optional so older writers and state files remain compatible. */
  requesters?: string[];
}

export const emptyHostCapacity = (): HostCapacity => ({
  resource: "host-capacity",
  capacity: 1,
  nextSequence: 0,
  active: null,
  waiting: [],
});

export function reapHostCapacity(
  state: QueueState,
  rows: ProcessRow[],
  observed?: HostJob[],
): void {
  state.host.waiting = state.host.waiting.filter(
    (job) =>
      // A waiter added during ps may not appear in that listing yet. Its next
      // observation can reap it; never discard it on an older snapshot.
      (observed &&
        !observed.some(
          (ticket) =>
            ticket.reservationId === job.reservationId &&
            JSON.stringify(ticket.holder) === JSON.stringify(job.holder),
        )) ||
      matchesProcess(job.holder, rows),
  );
  const active = state.host.active;

  if (
    active &&
    !(active.processGroup
      ? groupIsAlive(active.processGroup, rows)
      : matchesProcess(active.holder, rows))
  ) {
    state.host.active = null;
  }
}

function nextHostJob(host: HostCapacity, now: number): HostJob | undefined {
  const { waiting } = host;
  // Existing processes retain the old selector in memory. Keep its order until
  // those tickets drain, or old/new selectors could each wait for the other.
  // Never rewrite their tickets or sequence numbers during installation.
  if (waiting.some((job) => !job.requester)) {
    return (
      waiting.find((job) => job.class !== "checks" && now - job.queuedAt >= 15 * 60_000) ??
      waiting.find((job) => job.class === "checks") ??
      waiting[0]
    );
  }

  const present = new Set(waiting.map((job) => job.requester!));
  host.requesters = (host.requesters ?? []).filter((requester) => present.has(requester));
  for (const requester of present) {
    if (!host.requesters.includes(requester)) host.requesters.push(requester);
  }

  // A requester with the active slot has already had its turn. New arrivals
  // join ahead of its next turn, even if it queued its whole batch first.
  const active = host.active?.requester;
  if (active && host.requesters.includes(active)) {
    host.requesters = host.requesters.filter((requester) => requester !== active);
    host.requesters.push(active);
  }

  return waiting.find((job) => job.requester === host.requesters![0]);
}

export function claimHostCapacity(
  state: QueueState,
  job: HostJob,
  now: number,
  legacyBlocked: boolean,
): boolean {
  if (!state.host.waiting.some((ticket) => ticket.reservationId === job.reservationId)) {
    job.sequence = state.host.nextSequence++;
    state.host.waiting.push(job);
  }

  const next = nextHostJob(state.host, now);
  if (legacyBlocked || state.host.active || next?.reservationId !== job.reservationId) return false;

  state.host.waiting = state.host.waiting.filter(
    (ticket) => ticket.reservationId !== job.reservationId,
  );
  // Use the stored ticket: contention/retries must not replace its sequence or
  // immutable requester metadata with a caller's stale local copy.
  Object.assign(job, next, { acquiredAt: now });
  state.host.active = job;
  if (job.requester && state.host.requesters) {
    state.host.requesters = state.host.requesters.filter(
      (requester) => requester !== job.requester,
    );
    state.host.requesters.push(job.requester);
  }
  return true;
}

export function releaseHostCapacity(state: QueueState, reservationId: string): void {
  state.host.waiting = state.host.waiting.filter((job) => job.reservationId !== reservationId);
  if (state.host.active?.reservationId === reservationId) state.host.active = null;
}
