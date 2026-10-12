import { expect, test } from "bun:test";

import {
  DEVICE_QUEUE,
  type Device,
  type Platform,
  type Request,
  decide,
  emptyQueueState,
  reapQueue,
} from "./device-queue";

const NOW = 1_000_000_000;
const alive = () => true;

function devices(...list: Array<[id: string, booted: boolean, platform?: Platform]>) {
  return new Map<string, Device>(
    list.map(([id, booted, platform = "ios"]) => [id, { id, platform, name: id, booted }]),
  );
}

const request = (
  id: string,
  owner: string,
  agentPid = 10,
  platform: Platform = "ios",
): Request => ({
  id,
  platform,
  name: id,
  owner,
  agentPid,
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

test("idle leases and unleased devices are reclaimed only while someone waits for their platform", () => {
  const state = emptyQueueState();
  const fleet = devices(["held", true], ["loose", true], ["avd", true, "android"]);
  decide(state, request("held", "one"), fleet, NOW);
  reapQueue(state, fleet, NOW, alive);
  const later = NOW + DEVICE_QUEUE.leaseIdleMs + 1;

  expect(reapQueue(state, fleet, later, alive)).toEqual([]);

  decide(state, request("other", "two"), devices(["other", false]), later, 0);
  const reclaimed = reapQueue(state, fleet, later, alive).map(({ device }) => device.id);

  expect(reclaimed.sort()).toEqual(["held", "loose"]);
  expect(fleet.get("avd")?.booted).toBe(true);
});

test("acquiring again or a running device command keeps a lease while others wait", () => {
  const state = emptyQueueState();
  const fleet = devices(["built", true], ["driven", true], ["idle", true]);
  decide(state, request("built", "one", 10), fleet, NOW);
  decide(state, request("driven", "two", 20), fleet, NOW);
  decide(state, request("idle", "three", 30), fleet, NOW);
  const later = NOW + DEVICE_QUEUE.leaseIdleMs + 1;
  decide(state, request("other", "four", 40), devices(["other", false]), later, 0);

  expect(decide(state, request("driven", "two", 20), fleet, later)).toMatchObject({ renewed: true });
  // Only the holder's own processes count: agent 30 is not the one running a build on "idle".
  const busy = new Map([
    ["built", new Set([10])],
    ["idle", new Set([99])],
  ]);
  const reclaimed = reapQueue(state, fleet, later, alive, busy).map(({ device }) => device.id);

  expect(reclaimed).toEqual(["idle"]);
  expect(Object.keys(state.leases).sort()).toEqual(["built", "driven"]);
});
