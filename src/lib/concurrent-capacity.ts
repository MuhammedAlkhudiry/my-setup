import { prepareConcurrentTurns } from "./concurrent-turns";
import type { HostJob } from "./host-capacity";
import { groupIsAlive, matchesProcess, type ProcessRow } from "./process-identity";

export const HEAVY_CAPACITY = 3;

export interface ConcurrentJob extends HostJob {
  clientVersion?: "concurrent-v2" | "concurrent-v3";
}

export interface ConcurrentCapacity {
  resource: "host-capacity";
  capacity: number;
  nextSequence: number;
  active: ConcurrentJob[];
  waiting: ConcurrentJob[];
  requesters: string[];
  // Loaded v1/v2 clients retain unknown fields on read-modify-write. Keep fixed
  // anchors here so their releases cannot accidentally renew a backfill window.
  backfill?: { reservationId: string; anchors: string[] };
  legacyBackfill?: { anchors: string[] };
}

export const emptyConcurrentCapacity = (): ConcurrentCapacity => ({
  resource: "host-capacity",
  capacity: HEAVY_CAPACITY,
  nextSequence: 0,
  active: [],
  waiting: [],
  requesters: [],
});

export function reapConcurrentCapacity(
  host: ConcurrentCapacity,
  rows: ProcessRow[],
  observed: HostJob[],
): void {
  host.waiting = host.waiting.filter(
    (job) =>
      !observed.some(
        (ticket) =>
          ticket.reservationId === job.reservationId &&
          JSON.stringify(ticket.holder) === JSON.stringify(job.holder),
      ) || matchesProcess(job.holder, rows),
  );
  host.active = host.active.filter((job) =>
    job.processGroup ? groupIsAlive(job.processGroup, rows) : matchesProcess(job.holder, rows),
  );
}

export function claimConcurrentCapacity(
  host: ConcurrentCapacity,
  job: HostJob,
  now: number,
  blocked: boolean,
  otherActive: HostJob[] = [],
  legacyWaiting: HostJob[] = [],
): boolean {
  if (!host.waiting.some((ticket) => ticket.reservationId === job.reservationId)) {
    job.sequence = host.nextSequence++;
    host.waiting.push(job);
  }

  if (blocked) return false;

  const requester = (ticket: HostJob) => ticket.requester ?? ticket.reservationId;
  const { next, yieldLegacy } = prepareConcurrentTurns(
    host,
    otherActive,
    legacyWaiting,
    job.reservationId,
  );
  if (
    yieldLegacy ||
    host.active.length + otherActive.length >= HEAVY_CAPACITY ||
    [...host.active, ...otherActive].some((ticket) => ticket.class === "benchmark") ||
    next?.reservationId !== job.reservationId ||
    (job.class === "benchmark" && host.active.length + otherActive.length > 0)
  )
    return false;

  host.waiting = host.waiting.filter((ticket) => ticket.reservationId !== job.reservationId);
  Object.assign(job, next, { acquiredAt: now });
  host.active.push(job);
  host.requesters = host.requesters.filter((id) => id !== requester(job));
  host.requesters.push(requester(job));
  return true;
}

export function releaseConcurrentCapacity(host: ConcurrentCapacity, reservationId: string): void {
  host.waiting = host.waiting.filter((job) => job.reservationId !== reservationId);
  host.active = host.active.filter((job) => job.reservationId !== reservationId);
}
