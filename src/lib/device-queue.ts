import { emptyHostCapacity, type HostCapacity } from "./host-capacity";

export type Platform = "ios" | "android";

export const DEVICE_QUEUE = {
  /**
   * Devices allowed to run at once per platform. Slots above `baseSlots` open only while the host has headroom;
   * host-local overrides let smaller or larger Macs set their own maximum.
   */
  maxRunning: {
    ios: slotCount(process.env.DEVICE_QUEUE_IOS_SLOTS, 5),
    android: slotCount(process.env.DEVICE_QUEUE_ANDROID_SLOTS, 2),
  } satisfies Record<Platform, number>,
  /** Slots always open, whatever the host load. */
  baseSlots: { ios: 2, android: 2 } satisfies Record<Platform, number>,
  /**
   * A lease idle for this long is reclaimed, but only while someone waits for its platform. Running `acquire` again or
   * a running command aimed at the device, such as a build, keeps it active.
   */
  leaseIdleMs: 15 * 60_000,
  /** A waiting caller refreshes its ticket on every poll; one silent for this long has gone away. */
  ticketStaleMs: 2 * 60_000,
  /** Released devices stay ready for the next lease this long, then sleep. */
  warmIdleMs: 30 * 60_000,
  /** Released devices kept booted: one, or two while the host has headroom. */
  warmDevices: { base: 1, withHeadroom: 2 },
};

function slotCount(value: string | undefined, fallback: number): number {
  const count = Number(value);
  return value && Number.isSafeInteger(count) && count > 0 ? count : fallback;
}

/** SimLease's lane rule: extra lanes open at these levels and close below the lower ones. Load average is ignored. */
export const HEADROOM = {
  open: { cpuIdle: 30, memoryFree: 45 },
  close: { cpuIdle: 20, memoryFree: 40 },
  /** CPU idle is smoothed over about three minutes. */
  cpuSmoothingMs: 3 * 60_000,
  /** A reading older than this is replaced rather than smoothed. */
  staleMs: 10 * 60_000,
};

export interface Headroom {
  /** Smoothed percentage of CPU time left idle. */
  cpuIdle: number;
  /** Percentage of memory free, as macOS memory_pressure reports it. */
  memoryFree: number;
  sampledAt: number;
  /** Whether extra lanes are open: slots above the base and a second warm device. */
  open: boolean;
}

export interface Device {
  /** Simulator UDID, or the AVD name for an emulator. */
  id: string;
  platform: Platform;
  name: string;
  booted: boolean;
  /** adb serial of a running emulator. */
  serial?: string;
}

/** A pool member: one of the fixed devices a project leases by kind. */
export interface PoolMember {
  project: string;
  platform: Platform;
  kind: string;
  name: string;
  /** Members with a locale change the app's language, so they are handed out only when their kind is requested. */
  locale?: string;
}

export interface Lease {
  id: string;
  platform: Platform;
  name: string;
  project?: string;
  kind?: string;
  owner: string;
  /** The agent CLI process the lease belongs to; the lease ends when it exits. 0 when none was found. */
  agentPid: number;
  acquiredAt: number;
  /** Last acquire by the holder, or the last time it was seen running a command aimed at the device. */
  renewedAt: number;
}

export interface Ticket {
  platform: Platform;
  project?: string;
  kind?: string;
  /** Devices that satisfy the request. */
  candidates?: string[];
  /** The one device a caller from before the pool asked for. */
  id?: string;
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
  headroom?: Headroom;
}

export interface Request {
  project: string;
  platform: Platform;
  kind?: string;
  owner: string;
  agentPid: number;
  /** Pool devices that satisfy the request, in preference order. */
  candidates: Array<Pick<Device, "id" | "name">>;
}

export type Decision =
  | {
      granted: true;
      id: string;
      name: string;
      adopted: boolean;
      renewed: boolean;
      waitedMs: number;
    }
  | { granted: false; report: string };

export interface ReapOptions {
  warmDevices: number;
  slots: Record<Platform, number>;
}

export const emptyQueueState = (): QueueState => ({
  leases: {},
  tickets: {},
  unleasedSince: {},
  host: emptyHostCapacity(),
});

/** The members a request may receive: the named kind, or every member that keeps the app's own language. */
export function poolMembers<T extends PoolMember>(
  pool: T[],
  project: string,
  platform: Platform,
  kind?: string,
): T[] {
  return pool.filter(
    (member) =>
      member.project === project &&
      member.platform === platform &&
      (kind ? member.kind === kind : !member.locale),
  );
}

/** Smooths CPU idle across readings and opens or closes the extra lanes with SimLease's hysteresis. */
export function updateHeadroom(
  previous: Headroom | undefined,
  sample: Pick<Headroom, "cpuIdle" | "memoryFree">,
  now: number,
): Headroom {
  const fresh = previous !== undefined && now - previous.sampledAt < HEADROOM.staleMs;
  const weight = fresh
    ? 1 - Math.exp(-Math.max(0, now - previous.sampledAt) / HEADROOM.cpuSmoothingMs)
    : 1;
  const cpuIdle = fresh
    ? previous.cpuIdle + weight * (sample.cpuIdle - previous.cpuIdle)
    : sample.cpuIdle;
  const limits = fresh && previous.open ? HEADROOM.close : HEADROOM.open;

  return {
    cpuIdle,
    memoryFree: sample.memoryFree,
    sampledAt: now,
    open: cpuIdle >= limits.cpuIdle && sample.memoryFree >= limits.memoryFree,
  };
}

/** Slots above the base and the second warm device need headroom. */
export function laneLimits(open: boolean): ReapOptions {
  const slots = (platform: Platform) =>
    open
      ? DEVICE_QUEUE.maxRunning[platform]
      : Math.min(DEVICE_QUEUE.baseSlots[platform], DEVICE_QUEUE.maxRunning[platform]);
  return {
    warmDevices: open ? DEVICE_QUEUE.warmDevices.withHeadroom : DEVICE_QUEUE.warmDevices.base,
    slots: { ios: slots("ios"), android: slots("android") },
  };
}

const ticketKey = (
  request: Pick<Request, "project" | "platform" | "kind" | "agentPid" | "owner">,
) =>
  `${request.project}:${request.platform}:${request.kind ?? "*"}:${request.agentPid}:${request.owner}`;

const ticketCandidates = (ticket: Ticket) => ticket.candidates ?? (ticket.id ? [ticket.id] : []);

const sameHolder = (a: Pick<Lease, "agentPid" | "owner">, b: Pick<Lease, "agentPid" | "owner">) =>
  a.agentPid === b.agentPid && a.owner === b.owner;

/**
 * Drops stale tickets and leases. Released devices stay warm, newest first, up to `warmDevices`; a waiting request
 * that cannot use a warm device evicts it when every slot is occupied. Returned devices are shut down by the caller.
 */
export function reapQueue(
  state: QueueState,
  devices: Map<string, Device>,
  now: number,
  isAlive: (pid: number) => boolean,
  busy: Map<string, Set<number>> = new Map(),
  { warmDevices, slots }: ReapOptions = {
    warmDevices: DEVICE_QUEUE.warmDevices.base,
    slots: DEVICE_QUEUE.maxRunning,
  },
): Array<{ device: Device; reason: string }> {
  const shutdowns: Array<{ device: Device; reason: string }> = [];
  const reclaim = (device: Device | undefined, reason: string) => {
    if (!device?.booted) return;
    shutdowns.push({ device, reason });
    device.booted = false;
    delete state.unleasedSince[device.id];
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
      state.unleasedSince[lease.id] = now;
    }
  }

  for (const id of Object.keys(state.unleasedSince)) {
    if (!devices.get(id)?.booted || state.leases[id]) delete state.unleasedSince[id];
  }
  const warm = [...devices.values()]
    .filter((device) => device.booted && !state.leases[device.id])
    .sort((a, b) => (state.unleasedSince[b.id] ?? now) - (state.unleasedSince[a.id] ?? now));
  for (const device of warm) state.unleasedSince[device.id] ??= now;
  for (const device of warm.slice(warmDevices))
    reclaim(device, "enough warm devices are available");

  // A ticket needs a slot only when one of its devices is free and not already booted.
  const needsSlot = (ticket: Ticket) =>
    ticketCandidates(ticket).some((id) => !state.leases[id] && !devices.get(id)?.booted);
  for (const device of warm.slice(0, warmDevices)) {
    const queuedForOther = Object.values(state.tickets).some(
      (ticket) =>
        ticket.platform === device.platform &&
        !ticketCandidates(ticket).includes(device.id) &&
        needsSlot(ticket),
    );
    const occupied = [...devices.values()].filter(
      (candidate) => candidate.platform === device.platform && candidate.booted,
    ).length;
    if (now - state.unleasedSince[device.id]! > DEVICE_QUEUE.warmIdleMs)
      reclaim(device, "warm device timed out");
    else if (queuedForOther && occupied >= slots[device.platform])
      reclaim(device, "warm device yielded to a waiting lease");
  }
  return shutdowns;
}

/**
 * Renews a device the caller already holds, hands out a warm one at once since it already holds a slot, or boots a free
 * one when its platform has a free slot and nobody queued earlier. Otherwise files the request in the queue.
 */
export function decide(
  state: QueueState,
  request: Request,
  devices: Map<string, Device>,
  now: number,
  maxRunning: number = DEVICE_QUEUE.maxRunning[request.platform],
): Decision {
  const key = ticketKey(request);
  const createdAt = state.tickets[key]?.createdAt ?? now;
  const grant = (device: Pick<Device, "id" | "name">, adopted: boolean, renewed: boolean) => {
    const held = state.leases[device.id];
    state.leases[device.id] = {
      id: device.id,
      platform: request.platform,
      name: device.name,
      project: request.project,
      kind: request.kind,
      owner: request.owner,
      agentPid: request.agentPid,
      acquiredAt: renewed && held ? held.acquiredAt : now,
      renewedAt: now,
    };
    delete state.tickets[key];
    delete state.unleasedSince[device.id];
    return { granted: true as const, ...device, adopted, renewed, waitedMs: now - createdAt };
  };

  const mine = request.candidates.find((device) => {
    const held = state.leases[device.id];
    return held !== undefined && sameHolder(held, request);
  });
  if (mine) return grant(mine, false, true);

  const free = request.candidates.filter((device) => !state.leases[device.id]);
  const warm = free.find((device) => devices.get(device.id)?.booted);
  if (warm) return grant(warm, true, false);

  // A ticket whose devices are all held by others cannot use a free slot, so it does not keep others from one.
  const ahead = Object.entries(state.tickets).filter(
    ([otherKey, ticket]) =>
      otherKey !== key &&
      ticket.platform === request.platform &&
      ticket.createdAt < createdAt &&
      ticketCandidates(ticket).some((id) => !state.leases[id]),
  ).length;
  const inUse = new Set([
    ...Object.values(state.leases)
      .filter((lease) => lease.platform === request.platform)
      .map((lease) => lease.id),
    ...[...devices.values()]
      .filter((device) => device.platform === request.platform && device.booted)
      .map((device) => device.id),
  ]);
  if (free[0] && ahead < maxRunning - inUse.size) return grant(free[0], false, false);

  const { candidates, project, platform, kind, owner, agentPid } = request;
  state.tickets[key] = {
    project,
    platform,
    kind,
    owner,
    agentPid,
    candidates: candidates.map((device) => device.id),
    createdAt,
    seenAt: now,
  };
  if (!free.length) {
    const holders = candidates.map(
      (device) => `${device.name} -> "${state.leases[device.id]?.owner}"`,
    );
    return {
      granted: false,
      report: `waiting: every matching device is leased (${holders.join(", ")})`,
    };
  }
  return {
    granted: false,
    report: `queued: ${ahead + 1} in line, ${inUse.size}/${maxRunning} ${platform} slots in use`,
  };
}

/** Keeps a waiting request's place while a probe of the host fails and acquire retries it. */
export function keepTicket(
  state: QueueState,
  request: Pick<Request, "project" | "platform" | "kind" | "agentPid" | "owner">,
  now: number,
): void {
  const ticket = state.tickets[ticketKey(request)];
  if (ticket) ticket.seenAt = now;
}

/** simctl and adb report a device that is already off as an error; for a shutdown, that is the wanted outcome. */
export const alreadyShutDown = (stderr: string) =>
  /current state: Shutdown|No devices are booted|device '?[\w-]*'? not found|Invalid device/i.test(
    stderr,
  );

/** An AVD config that always cold-boots, whatever quick-boot setting Android Studio or avdslim left in it. */
export function coldBootConfig(config: string): string {
  const settings = { "fastboot.forceColdBoot": "yes", "fastboot.forceFastBoot": "no" };
  let cold = config;
  for (const [key, value] of Object.entries(settings)) {
    const line = new RegExp(`^${RegExp.escape(key)}=.*$`, "m");
    cold = line.test(cold)
      ? cold.replace(line, `${key}=${value}`)
      : `${cold.replace(/\n?$/, "\n")}${key}=${value}\n`;
  }
  return cold;
}

/** An iOS runtime as `xcrun simctl list devicetypes runtimes -j` reports it, with the device types it can create. */
export interface SimRuntime {
  identifier: string;
  version: string;
  platform?: string;
  isAvailable?: boolean;
  supportedDeviceTypes?: Array<{ identifier: string; name: string; productFamily?: string }>;
}

/** iPhone lines from the smallest screen up, and in the order a standard-size member falls back to them. */
const IPHONE_LINES = {
  small: ["se", "mini", "e", "base", "pro", "other", "air", "large"],
  standard: ["pro", "base", "other", "e", "air", "mini", "se", "large"],
};

function iphoneLine(name: string): string {
  if (/\bSE\b/.test(name)) return "se";
  if (name.endsWith(" mini")) return "mini";
  if (/^iPhone \d+e$/.test(name)) return "e";
  if (/^iPhone \d+$/.test(name)) return "base";
  if (/^iPhone \d+ Pro$/.test(name)) return "pro";
  if (name.endsWith(" Air")) return "air";
  if (/ (Plus|Max)$/.test(name)) return "large";
  return "other";
}

/**
 * The device type a missing simulator is created with: the member's own type when the runtime supports it, otherwise
 * the newest supported iPhone closest to its kind: the smallest screen for `small`, and the standard Pro or base
 * iPhone for every other kind. New Xcode releases drop older types, so a fixed type alone breaks creation.
 */
export function simulatorDeviceType(
  member: Pick<PoolMember, "kind"> & { deviceType?: string },
  runtime: SimRuntime,
): string | undefined {
  const iphones = (runtime.supportedDeviceTypes ?? []).filter(
    (type) => type.productFamily === "iPhone",
  );
  if (iphones.some((type) => type.identifier === member.deviceType)) return member.deviceType;

  const lines = member.kind === "small" ? IPHONE_LINES.small : IPHONE_LINES.standard;
  const generation = (name: string) => Number(name.match(/\d+/)?.[0] ?? 0);
  return iphones.toSorted(
    (a, b) =>
      lines.indexOf(iphoneLine(a.name)) - lines.indexOf(iphoneLine(b.name)) ||
      generation(b.name) - generation(a.name),
  )[0]?.identifier;
}

export function releaseLease(state: QueueState, id: string, now = Date.now()): Lease | undefined {
  const lease = state.leases[id];
  delete state.leases[id];
  if (lease) state.unleasedSince[id] = now;
  return lease;
}
