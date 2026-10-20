import type { ConcurrentCapacity, ConcurrentJob } from "./concurrent-capacity";
import type { HostJob } from "./host-capacity";

export const CURRENT_HEAVY_CLIENT = "concurrent-v4" as const;
const requester = (job: HostJob) => job.requester ?? job.reservationId;

function rotate(host: ConcurrentCapacity, eligible: ConcurrentJob[]): void {
  const present = new Set(eligible.map(requester));
  host.requesters = host.requesters.filter((id) => present.has(id));
  for (const id of present) {
    if (host.requesters.includes(id)) continue;
    const index = host.requesters.findIndex((id) =>
      host.active.some((job) => requester(job) === id),
    );
    host.requesters.splice(index < 0 ? host.requesters.length : index, 0, id);
  }
}

/** Only requester heads can backfill; never overtake a requester's own FIFO. */
export function prepareConcurrentTurns(
  host: ConcurrentCapacity,
  otherActive: HostJob[] = [],
  legacyWaiting: HostJob[] = [],
  claimingId?: string,
): { next?: ConcurrentJob; yieldLegacy: boolean } {
  const heads = new Map<string, ConcurrentJob>();
  for (const job of host.waiting) if (!heads.has(requester(job))) heads.set(requester(job), job);
  const activeIds = new Set(host.active.map((job) => job.reservationId));
  const stillRunning = (anchors: string[]) => anchors.some((id) => activeIds.has(id));

  if (otherActive.length || !legacyWaiting.length) delete host.legacyBackfill;
  else host.legacyBackfill ??= { anchors: [...activeIds] };

  // Older clients cannot share the serial lane or pass a serial waiter. Their
  // tickets stay intact, including the FIFO of requesters with an older head.
  if (otherActive.length || legacyWaiting.length) {
    const eligible = host.waiting.filter(
      (job) =>
        job.clientVersion === CURRENT_HEAVY_CLIENT &&
        heads.get(requester(job))?.clientVersion === CURRENT_HEAVY_CLIENT,
    );
    rotate(host, eligible);
    return {
      next: eligible.find((job) => requester(job) === host.requesters[0]),
      yieldLegacy: !!host.legacyBackfill && !stillRunning(host.legacyBackfill.anchors),
    };
  }

  rotate(host, host.waiting);
  const saved = host.backfill;
  let priority = saved && host.waiting.find((job) => job.reservationId === saved.reservationId);
  if (!priority || heads.get(requester(priority)) !== priority) {
    delete host.backfill;
    priority = host.waiting.find((job) => requester(job) === host.requesters[0]);
  }
  if (
    !priority ||
    priority.clientVersion === CURRENT_HEAVY_CLIENT ||
    priority.reservationId === claimingId
  )
    return { next: priority, yieldLegacy: false };

  host.backfill ??= { reservationId: priority.reservationId, anchors: [...activeIds] };
  // Keep one slot available for an older head's own polling.
  const free =
    host.capacity - 1 - host.active.filter((job) => job.reservationMode !== "express").length;
  const backfill = host.requesters
    .map((id) => heads.get(id)!)
    .filter((job) => requester(job) !== requester(priority!))
    .slice(0, Math.max(0, free));
  const front = [...backfill.map(requester), requester(priority)];
  host.requesters = [...front, ...host.requesters.filter((id) => !front.includes(id))];
  return { next: backfill[0] ?? priority, yieldLegacy: false };
}
