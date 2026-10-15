import { emptyHostCapacity, type HostCapacity } from "./host-capacity";

export type Platform = "ios" | "android";

export const DEVICE_QUEUE = {
  /** Devices allowed to run at once per platform on this 48 GB Mac; further requests wait in a first-come queue. */
  maxRunning: { ios: 3, android: 1 } satisfies Record<Platform, number>,
  /**
   * A lease idle for this long is reclaimed, but only while someone waits for its platform. Running `acquire` again or
   * a running command aimed at the device, such as a build, keeps it active.
   */
  leaseIdleMs: 15 * 60_000,
  /** A waiting caller refreshes its ticket on every poll; one silent for this long has gone away. */
  ticketStaleMs: 2 * 60_000,
  /** A device booted without a lease is shut down after this long, but only while someone waits for its platform. */
  unleasedGraceMs: 5 * 60_000,
};

export interface Device {
  /** Simulator UDID, or the AVD name for an emulator. */
  id: string;
  platform: Platform;
  name: string;
  booted: boolean;
  /** adb serial of a running emulator. */
  serial?: string;
}

export interface Lease {
  id: string;
  platform: Platform;
  name: string;
  owner: string;
  /** The agent CLI process the lease belongs to; the lease ends when it exits. 0 when none was found. */
  agentPid: number;
  acquiredAt: number;
  /** Last acquire by the holder, or the last time it was seen running a command aimed at the device. */
  renewedAt: number;
}

export interface Ticket {
  id: string;
  platform: Platform;
  owner: string;
  agentPid: number;
  createdAt: number;
  seenAt: number;
}

export interface QueueState {
  host: HostCapacity;
  leases: Record<string, Lease>;
  tickets: Record<string, Ticket>;
  unleasedSince: Record<string, number>;
}

export interface Request {
  id: string;
  platform: Platform;
  name: string;
  owner: string;
  agentPid: number;
}

export type Decision =
  | { granted: true; adopted: boolean; renewed: boolean; waitedMs: number }
  | { granted: false; report: string };

export const emptyQueueState = (): QueueState => ({
  leases: {},
  tickets: {},
  unleasedSince: {},
  host: emptyHostCapacity(),
});

const ticketKey = (request: Pick<Ticket, "id" | "agentPid" | "owner">) =>
  `${request.id}:${request.agentPid}:${request.owner}`;

const sameHolder = (a: Pick<Lease, "agentPid" | "owner">, b: Pick<Lease, "agentPid" | "owner">) =>
  a.agentPid === b.agentPid && a.owner === b.owner;

/**
 * Drops tickets whose caller went away and leases whose session ended. A device whose session ended stays booted, so the
 * session can claim it again after a restart. A lease counts as active while `busy` holds its device for its agent, such as
 * during a build or test run. While someone waits for a platform, its idle leases and devices booted without a lease past
 * the grace period are reclaimed; they are returned for the caller to shut down.
 */
export function reapQueue(
  state: QueueState,
  devices: Map<string, Device>,
  now: number,
  isAlive: (pid: number) => boolean,
  busy: Map<string, Set<number>> = new Map(),
): Array<{ device: Device; reason: string }> {
  const shutdowns: Array<{ device: Device; reason: string }> = [];
  const reclaim = (device: Device | undefined, reason: string) => {
    if (!device?.booted) return;
    shutdowns.push({ device, reason });
    device.booted = false;
  };

  for (const [key, ticket] of Object.entries(state.tickets)) {
    if (now - ticket.seenAt > DEVICE_QUEUE.ticketStaleMs || !isAlive(ticket.agentPid))
      delete state.tickets[key];
  }
  const waiting = new Set(Object.values(state.tickets).map((ticket) => ticket.platform));

  for (const lease of Object.values(state.leases)) {
    if (!isAlive(lease.agentPid)) {
      delete state.leases[lease.id];
    } else if (busy.get(lease.id)?.has(lease.agentPid)) {
      lease.renewedAt = now;
    } else if (waiting.has(lease.platform) && now - lease.renewedAt > DEVICE_QUEUE.leaseIdleMs) {
      delete state.leases[lease.id];
      reclaim(devices.get(lease.id), `lease of "${lease.owner}" sat idle while others waited`);
    }
  }

  for (const id of Object.keys(state.unleasedSince)) {
    if (!devices.get(id)?.booted || state.leases[id]) delete state.unleasedSince[id];
  }
  for (const device of devices.values()) {
    if (!device.booted || state.leases[device.id]) continue;
    state.unleasedSince[device.id] ??= now;
    if (
      waiting.has(device.platform) &&
      now - state.unleasedSince[device.id] > DEVICE_QUEUE.unleasedGraceMs
    ) {
      delete state.unleasedSince[device.id];
      reclaim(device, "booted without a lease while others waited");
    }
  }
  return shutdowns;
}

/**
 * Grants the request when its platform has a free slot and nobody queued earlier, or files it in the queue. A device that
 * is already booted without a lease is granted at once, since it already holds a slot.
 */
export function decide(
  state: QueueState,
  request: Request,
  devices: Map<string, Device>,
  now: number,
  maxRunning: number = DEVICE_QUEUE.maxRunning[request.platform],
): Decision {
  const key = ticketKey(request);
  const held = state.leases[request.id];
  const mine = held !== undefined && sameHolder(held, request);
  const createdAt = state.tickets[key]?.createdAt ?? now;

  // A ticket waiting for a device someone else holds cannot use a free slot, so it does not keep others from one.
  const ahead = Object.entries(state.tickets).filter(([otherKey, ticket]) => {
    const blocked = state.leases[ticket.id] && !sameHolder(state.leases[ticket.id], ticket);
    return (
      otherKey !== key &&
      ticket.platform === request.platform &&
      ticket.createdAt < createdAt &&
      !blocked
    );
  }).length;
  const inUse = new Set([
    ...Object.values(state.leases)
      .filter((lease) => lease.platform === request.platform)
      .map((lease) => lease.id),
    ...[...devices.values()]
      .filter((device) => device.platform === request.platform && device.booted)
      .map((device) => device.id),
  ]);
  const adopted = !held && devices.get(request.id)?.booted === true;

  if (mine || adopted || (!held && ahead < maxRunning - inUse.size)) {
    state.leases[request.id] = {
      ...request,
      acquiredAt: mine ? held.acquiredAt : now,
      renewedAt: now,
    };
    delete state.tickets[key];
    delete state.unleasedSince[request.id];
    return { granted: true, adopted, renewed: mine, waitedMs: now - createdAt };
  }

  const { name: _name, ...ticket } = request;
  state.tickets[key] = { ...ticket, createdAt, seenAt: now };
  return {
    granted: false,
    report: held
      ? `waiting for ${held.name}, leased to "${held.owner}"`
      : `queued: ${ahead + 1} in line, ${inUse.size}/${maxRunning} ${request.platform} slots in use`,
  };
}

export function releaseLease(state: QueueState, id: string): Lease | undefined {
  const lease = state.leases[id];
  delete state.leases[id];
  return lease;
}
