import { expect, test } from "bun:test";

import {
  DEVICE_QUEUE,
  type Device,
  type Platform,
  type Request,
  alreadyShutDown,
  coldBootConfig,
  decide,
  emptyQueueState,
  keepTicket,
  laneLimits,
  poolMembers,
  reapQueue,
  releaseLease,
  simulatorDeviceType,
  updateHeadroom,
} from "./device-queue";

const NOW = 1_000_000_000;
const alive = () => true;
const THREE_SLOTS = { warmDevices: 1, slots: { ios: 3, android: 2 } };

function devices(...list: Array<[id: string, booted: boolean, platform?: Platform]>) {
  return new Map<string, Device>(
    list.map(([id, booted, platform = "ios"]) => [id, { id, platform, name: id, booted }]),
  );
}

/** A request any of `ids` satisfies, in preference order. */
const request = (
  ids: string | string[],
  owner: string,
  agentPid = 10,
  platform: Platform = "ios",
): Request => ({
  project: "app",
  platform,
  owner,
  agentPid,
  candidates: [ids].flat().map((id) => ({ id, name: id })),
});

test("grants free slots, then queues further requests first come, first served", () => {
  const state = emptyQueueState();
  const fleet = devices(["a", false], ["b", false], ["c", false]);

  expect(decide(state, request("a", "one"), fleet, NOW, 1).granted).toBe(true);
  expect(decide(state, request("b", "two"), fleet, NOW + 1, 1).granted).toBe(false);
  expect(decide(state, request("c", "three"), fleet, NOW + 2, 1).granted).toBe(false);

  delete state.leases.a;
  expect(decide(state, request("c", "three"), fleet, NOW + 3, 1).granted).toBe(false);
  expect(decide(state, request("b", "two"), fleet, NOW + 4, 1)).toMatchObject({
    granted: true,
    waitedMs: 3,
  });
});

test("grants a device already booted without a lease even when every slot is taken", () => {
  const state = emptyQueueState();
  const fleet = devices(["a", true], ["b", true]);

  decide(state, request("a", "one"), fleet, NOW, 1);
  expect(decide(state, request("b", "two"), fleet, NOW, 1)).toEqual({
    granted: true,
    id: "b",
    name: "b",
    adopted: true,
    renewed: false,
    waitedMs: 0,
  });
});

test("a request waiting for a device someone else holds does not block a free slot", () => {
  const state = emptyQueueState();
  const fleet = devices(["a", false], ["b", false]);

  decide(state, request("a", "one"), fleet, NOW, 2);
  expect(decide(state, request("a", "two"), fleet, NOW + 1, 2).granted).toBe(false);
  expect(decide(state, request("b", "three"), fleet, NOW + 2, 2).granted).toBe(true);
});

test("an ended session's lease drops but its device stays booted for the session to claim again", () => {
  const state = emptyQueueState();
  const fleet = devices(["a", true]);
  decide(state, request("a", "one", 10), fleet, NOW);

  const shutdowns = reapQueue(state, fleet, NOW + 1, (pid) => pid !== 10);

  expect(shutdowns).toEqual([]);
  expect(state.leases.a).toBeUndefined();
  expect(decide(state, request("a", "one", 11), fleet, NOW + 2).granted).toBe(true);
});

test("release keeps one warm device for the next lease", () => {
  const state = emptyQueueState();
  const fleet = devices(["a", true]);
  decide(state, request("a", "one"), fleet, NOW);

  expect(releaseLease(state, "a", NOW + 1)?.owner).toBe("one");
  expect(reapQueue(state, fleet, NOW + 2, alive)).toEqual([]);
  expect(decide(state, request("a", "two"), fleet, NOW + 3)).toMatchObject({
    granted: true,
    adopted: true,
  });
});

test("only one warm device survives and it yields when a different device needs the slot", () => {
  const state = emptyQueueState();
  const fleet = devices(
    ["older", true],
    ["newer", true],
    ["held-one", true],
    ["held-two", true],
    ["other", false],
  );
  decide(state, request("older", "one"), fleet, NOW);
  decide(state, request("newer", "two"), fleet, NOW);
  decide(state, request("held-one", "three"), fleet, NOW);
  decide(state, request("held-two", "four"), fleet, NOW);
  releaseLease(state, "older", NOW + 1);
  releaseLease(state, "newer", NOW + 2);

  expect(reapQueue(state, fleet, NOW + 3, alive).map(({ device }) => device.id)).toEqual(["older"]);
  expect(fleet.get("newer")?.booted).toBe(true);

  decide(state, request("other", "five"), fleet, NOW + 4, 3);
  const yielded = reapQueue(state, fleet, NOW + 5, alive, new Map(), THREE_SLOTS);
  expect(yielded.map(({ device }) => device.id)).toEqual(["newer"]);
  expect(decide(state, request("other", "five"), fleet, NOW + 6, 3).granted).toBe(true);
});

test("only one device stays warm across simulator and emulator platforms", () => {
  const state = emptyQueueState();
  const fleet = devices(["sim", true], ["emulator", true, "android"]);
  decide(state, request("sim", "one"), fleet, NOW);
  decide(state, request("emulator", "two", 20, "android"), fleet, NOW);
  releaseLease(state, "sim", NOW + 1);
  releaseLease(state, "emulator", NOW + 2);

  expect(reapQueue(state, fleet, NOW + 3, alive).map(({ device }) => device.id)).toEqual(["sim"]);
  expect(fleet.get("emulator")?.booted).toBe(true);
});

test("a warm device sleeps after its idle window", () => {
  const state = emptyQueueState();
  const fleet = devices(["warm", true]);
  decide(state, request("warm", "one"), fleet, NOW);
  releaseLease(state, "warm", NOW);

  expect(reapQueue(state, fleet, NOW + DEVICE_QUEUE.warmIdleMs, alive)).toEqual([]);
  expect(reapQueue(state, fleet, NOW + DEVICE_QUEUE.warmIdleMs + 1, alive)).toHaveLength(1);
});

test("acquiring again or a running device command keeps a lease while others wait", () => {
  const state = emptyQueueState();
  const fleet = devices(["built", true], ["driven", true], ["idle", true]);
  decide(state, request("built", "one", 10), fleet, NOW);
  decide(state, request("driven", "two", 20), fleet, NOW);
  decide(state, request("idle", "three", 30), fleet, NOW);
  const later = NOW + DEVICE_QUEUE.leaseIdleMs + 1;
  decide(state, request("other", "four", 40), devices(["other", false]), later, 0);

  expect(decide(state, request("driven", "two", 20), fleet, later)).toMatchObject({
    renewed: true,
  });
  // Only the holder's own processes count: agent 30 is not the one running a build on "idle".
  const busy = new Map([
    ["built", new Set([10])],
    ["idle", new Set([99])],
  ]);
  const reclaimed = reapQueue(state, fleet, later, alive, busy, THREE_SLOTS).map(
    ({ device }) => device.id,
  );

  expect(reclaimed).toEqual(["idle"]);
  expect(Object.keys(state.leases).sort()).toEqual(["built", "driven"]);
});

test("a pool request renews the caller's device, then prefers a warm one, then boots a free one", () => {
  const state = emptyQueueState();
  const fleet = devices(["main", false], ["small", true], ["spare", false]);
  const pool = ["main", "small", "spare"];

  expect(decide(state, request(pool, "one", 10), fleet, NOW)).toMatchObject({
    id: "small",
    adopted: true,
  });
  expect(decide(state, request(pool, "one", 10), fleet, NOW + 1)).toMatchObject({
    id: "small",
    renewed: true,
  });
  expect(decide(state, request(pool, "two", 20), fleet, NOW + 2)).toMatchObject({
    id: "main",
    adopted: false,
  });
});

test("a pool request waits while every matching device is leased, without blocking other requests", () => {
  const state = emptyQueueState();
  const fleet = devices(["main", false], ["other", false]);
  decide(state, request("main", "one", 10), fleet, NOW);

  expect(decide(state, request("main", "two", 20), fleet, NOW + 1)).toMatchObject({
    granted: false,
    report: expect.stringContaining("every matching device is leased"),
  });
  expect(decide(state, request("other", "three", 30), fleet, NOW + 2).granted).toBe(true);
  releaseLease(state, "main", NOW + 3);
  expect(decide(state, request("main", "two", 20), fleet, NOW + 4)).toMatchObject({
    granted: true,
    waitedMs: 3,
  });
});

test("only a requested kind hands out a device that changes the app's language", () => {
  const pool = [
    { project: "app", platform: "ios" as const, kind: "main", name: "Main" },
    { project: "app", platform: "ios" as const, kind: "rtl", name: "RTL", locale: "ar_SA" },
    { project: "app", platform: "android" as const, kind: "main", name: "Main_AVD" },
    { project: "other", platform: "ios" as const, kind: "main", name: "Other" },
  ];

  expect(poolMembers(pool, "app", "ios").map((member) => member.name)).toEqual(["Main"]);
  expect(poolMembers(pool, "app", "ios", "rtl").map((member) => member.name)).toEqual(["RTL"]);
  expect(poolMembers(pool, "app", "ios", "small")).toEqual([]);
});

test("a warm device stays for a waiting request that can use it", () => {
  const state = emptyQueueState();
  const fleet = devices(["warm", true], ["held", true]);
  decide(state, request("warm", "one"), fleet, NOW);
  decide(state, request("held", "two"), fleet, NOW);
  releaseLease(state, "warm", NOW + 1);
  decide(state, request(["held", "warm"], "three", 30), devices(["held", true]), NOW + 2, 0);

  expect(reapQueue(state, fleet, NOW + 3, alive, new Map(), laneLimits(false))).toEqual([]);
});

test("extra lanes open with CPU and memory headroom and close below the lower thresholds", () => {
  const roomy = updateHeadroom(undefined, { cpuIdle: 35, memoryFree: 50 }, NOW);
  expect(roomy.open).toBe(true);
  // Smoothed: one minute of 0% idle only pulls 35% partway down, and the lane stays open above 20%.
  const busy = updateHeadroom(roomy, { cpuIdle: 0, memoryFree: 50 }, NOW + 60_000);
  expect(busy.cpuIdle).toBeGreaterThan(20);
  expect(busy.open).toBe(true);
  expect(updateHeadroom(busy, { cpuIdle: 0, memoryFree: 50 }, NOW + 6 * 60_000).open).toBe(false);
  expect(updateHeadroom(roomy, { cpuIdle: 35, memoryFree: 39 }, NOW + 1).open).toBe(false);
  expect(updateHeadroom(undefined, { cpuIdle: 25, memoryFree: 90 }, NOW).open).toBe(false);

  expect(laneLimits(false)).toEqual({
    warmDevices: 1,
    slots: { ios: 2, android: 2 },
  });
  expect(laneLimits(true)).toEqual({ warmDevices: 2, slots: { ios: 5, android: 2 } });
});

test("two released devices stay warm while the host has headroom", () => {
  const state = emptyQueueState();
  const fleet = devices(["older", true], ["newer", true], ["oldest", true]);
  for (const id of ["oldest", "older", "newer"]) decide(state, request(id, id), fleet, NOW);
  releaseLease(state, "oldest", NOW + 1);
  releaseLease(state, "older", NOW + 2);
  releaseLease(state, "newer", NOW + 3);

  const reclaimed = reapQueue(state, fleet, NOW + 4, alive, new Map(), laneLimits(true));
  expect(reclaimed.map(({ device }) => device.id)).toEqual(["oldest"]);
});

test("a waiting request keeps its place while host probes fail and acquire retries", () => {
  const state = emptyQueueState();
  const fleet = devices(["main", false], ["held", false]);
  decide(state, request("held", "holder", 10), fleet, NOW, 1);
  decide(state, request("main", "first", 20), fleet, NOW + 1, 1);
  decide(state, request("main", "second", 30), fleet, NOW + 2, 1);

  // Probes for "first" time out for longer than a ticket may go unseen; each retry refreshes it.
  const later = NOW + DEVICE_QUEUE.ticketStaleMs + 10;
  keepTicket(state, request("main", "first", 20), NOW + DEVICE_QUEUE.ticketStaleMs);
  decide(state, request("main", "second", 30), fleet, later, 1);
  reapQueue(state, fleet, later, alive);
  delete state.leases.held;

  expect(decide(state, request("main", "second", 30), fleet, later + 1, 1).granted).toBe(false);
  expect(decide(state, request("main", "first", 20), fleet, later + 2, 1)).toMatchObject({
    granted: true,
    waitedMs: later + 1 - NOW,
  });
});

test("a device that is already off counts as shut down", () => {
  expect(alreadyShutDown("Unable to shutdown device in current state: Shutdown")).toBe(true);
  expect(alreadyShutDown("error: device 'emulator-5554' not found")).toBe(true);
  expect(alreadyShutDown("CoreSimulator service connection interrupted")).toBe(false);
});

test("pool emulators always cold-boot, whatever quick-boot setting the AVD had", () => {
  const quick =
    "hw.gpu.mode=host\nfastboot.forceColdBoot=no\nfastboot.forceFastBoot=yes\nhw.ramSize=2048\n";

  expect(coldBootConfig(quick)).toBe(
    "hw.gpu.mode=host\nfastboot.forceColdBoot=yes\nfastboot.forceFastBoot=no\nhw.ramSize=2048\n",
  );
  expect(coldBootConfig(coldBootConfig(quick))).toBe(coldBootConfig(quick));
  expect(coldBootConfig("hw.ramSize=2048")).toBe(
    "hw.ramSize=2048\nfastboot.forceColdBoot=yes\nfastboot.forceFastBoot=no\n",
  );
});

test("a missing simulator falls back to the closest iPhone its runtime supports", () => {
  const type = (name: string, productFamily = "iPhone") => ({
    identifier: `type.${name.replaceAll(" ", "-")}`,
    name,
    productFamily,
  });
  const runtime = (...names: string[]) => ({
    identifier: "ios",
    version: "27.1",
    supportedDeviceTypes: [
      type("iPad Pro 11-inch (M5)", "iPad"),
      ...names.map((name) => type(name)),
    ],
  });
  const main = { kind: "main", deviceType: "type.iPhone-17-Pro" };
  const rtl = { kind: "rtl", deviceType: "type.iPhone-17-Pro" };
  const small = { kind: "small", deviceType: "type.iPhone-SE-(3rd-generation)" };
  const lineup = runtime(
    "iPhone 18 Pro Max",
    "iPhone 18",
    "iPhone 18 Pro",
    "iPhone Air",
    "iPhone 17e",
    "iPhone 16 Pro",
    "iPhone 13 mini",
    "iPhone 12 mini",
  );

  expect(simulatorDeviceType(main, runtime("iPhone 18 Pro", "iPhone 17 Pro"))).toBe(
    "type.iPhone-17-Pro",
  );
  expect(simulatorDeviceType(main, lineup)).toBe("type.iPhone-18-Pro");
  expect(simulatorDeviceType(rtl, runtime("iPhone 18 Pro Max", "iPhone 18", "iPhone 17"))).toBe(
    "type.iPhone-18",
  );
  expect(simulatorDeviceType(small, lineup)).toBe("type.iPhone-13-mini");
  expect(simulatorDeviceType(small, runtime("iPhone 18", "iPhone 17e"))).toBe("type.iPhone-17e");
  // Xcode 27.1's iOS 27.1 runtime supports a single new iPhone line, so every kind gets it.
  expect(simulatorDeviceType(main, runtime("iPhone Duo"))).toBe("type.iPhone-Duo");
  expect(simulatorDeviceType(small, runtime("iPhone Duo"))).toBe("type.iPhone-Duo");
  expect(simulatorDeviceType(main, runtime())).toBeUndefined();
});
