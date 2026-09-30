import { expect, test } from "bun:test";

import { MAC_WATCHER, MEMCAP_CONFIG } from "../../config/mac-watcher";
import {
  type Alert,
  type GateInput,
  isMemcapActionLine,
  macWatcherPaths,
  mergeAlerts,
  pruneAlerts,
  renderMemcapConfig,
  renderWatcherLaunchAgent,
  reviewReasons,
} from "./mac-watcher";

const quiet: GateInput = {
  freePercent: 60,
  pressureLevel: "normal",
  swapUsedGib: 1,
  diskFreeGib: 200,
  newOrphanCount: 0,
  loadAverage15: 6,
  cores: 14,
  newSustainedCpuCount: 0,
  guardStops: 0,
  memcapActionLines: 0,
  memcapHealthy: true,
  hoursSinceReview: 2,
};

const leak = {
  key: "playwright-orphans",
  severity: "warning" as const,
  title: "Playwright browsers outlive their MCP server",
  evidence: "4 orphaned Chrome for Testing roots",
  fix: "Update Playwright MCP",
};

test("a healthy machine skips the Codex review", () => {
  expect(reviewReasons(quiet)).toEqual([]);
});

test("pressure, low disk, new leaks, memcap trouble, and the daily refresh each trigger a review", () => {
  expect(reviewReasons({ ...quiet, pressureLevel: "warning" })).toEqual(["memory pressure warning"]);
  expect(reviewReasons({ ...quiet, diskFreeGib: 12 })).toEqual(["disk free 12 GiB"]);
  expect(reviewReasons({ ...quiet, loadAverage15: 21 })).toEqual(["load 21.0 on 14 cores"]);
  expect(reviewReasons({ ...quiet, newSustainedCpuCount: 1 })).toEqual(["1 new sustained CPU users"]);
  expect(reviewReasons({ ...quiet, guardStops: 2 })).toEqual(["2 CPU guard stops since last run"]);
  expect(reviewReasons({ ...quiet, newOrphanCount: 3 })).toEqual(["3 new orphaned agent processes"]);
  expect(reviewReasons({ ...quiet, memcapHealthy: false })).toEqual(["memcap not healthy"]);
  expect(reviewReasons({ ...quiet, hoursSinceReview: undefined })).toEqual(["daily memory refresh"]);
  expect(reviewReasons({ ...quiet, hoursSinceReview: 25 })).toEqual(["daily memory refresh"]);
});

test("an alert opens, stays open while seen, and closes after enough clear reviews", () => {
  const first = mergeAlerts([], [leak], "t1", 2);
  expect(first.opened.map((alert) => alert.key)).toEqual(["playwright-orphans"]);

  const seenAgain = mergeAlerts(first.alerts, [leak], "t2", 2);
  expect(seenAgain.opened).toEqual([]);
  expect(seenAgain.alerts[0]).toMatchObject({ status: "open", seenCount: 2, clearReviews: 0 });

  const clearOnce = mergeAlerts(seenAgain.alerts, [], "t3", 2);
  expect(clearOnce.alerts[0]).toMatchObject({ status: "open", clearReviews: 1 });

  const clearTwice = mergeAlerts(clearOnce.alerts, [], "t4", 2);
  expect(clearTwice.resolved.map((alert) => alert.key)).toEqual(["playwright-orphans"]);
  expect(clearTwice.alerts[0]).toMatchObject({ status: "resolved", resolvedBy: "auto", resolvedAt: "t4" });
});

test("a resolved alert reopens and notifies when the issue comes back", () => {
  const resolved: Alert = {
    ...leak,
    status: "resolved",
    firstSeen: "t1",
    lastSeen: "t1",
    seenCount: 1,
    clearReviews: 0,
    resolvedAt: "t2",
    resolvedBy: "manual",
  };
  const merged = mergeAlerts([resolved], [leak], "t3");
  expect(merged.opened).toHaveLength(1);
  expect(merged.alerts[0]).toMatchObject({ status: "open", seenCount: 2, resolvedAt: undefined });
});

test("old resolved alerts are pruned and open ones are kept", () => {
  const now = new Date("2026-09-28T00:00:00Z");
  const base = { ...leak, firstSeen: "x", lastSeen: "x", seenCount: 1, clearReviews: 0 };
  const alerts: Alert[] = [
    { ...base, key: "old", status: "resolved", resolvedAt: "2026-08-01T00:00:00Z" },
    { ...base, key: "recent", status: "resolved", resolvedAt: "2026-09-20T00:00:00Z" },
    { ...base, key: "open", status: "open" },
  ];
  expect(pruneAlerts(alerts, now).map((alert) => alert.key)).toEqual(["recent", "open"]);
});

test("the memcap config renders every managed key as a parseable shell assignment", () => {
  const config = renderMemcapConfig();
  for (const key of Object.keys(MEMCAP_CONFIG)) expect(config).toMatch(new RegExp(`^${key}=`, "m"));
  expect(config).toContain("AGENT_JOB_MAX_GB=8");
  expect(config).toContain('GC_MODE="observe"');
  expect(Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(config) }).exitCode).toBe(0);
});

test("the launch agent runs the watcher on every scheduled time with a usable PATH", () => {
  const home = "/Users/test";
  const plist = renderWatcherLaunchAgent({
    mode: "run",
    paths: macWatcherPaths(home),
    bun: "/Users/test/.bun/bin/bun",
    script: "/repo/src/commands/mac-watcher.ts",
    home,
  });
  expect(plist).toContain(`<string>${MAC_WATCHER.label}</string>`);
  expect(plist.match(/<key>Hour<\/key>/g)).toHaveLength(MAC_WATCHER.schedule.length);
  expect(plist).toContain("/opt/homebrew/bin");
  expect(Bun.spawnSync(["plutil", "-lint", "-"], { stdin: Buffer.from(plist) }).exitCode).toBe(0);
});

test("routine memcap lines do not count as actions", () => {
  expect(isMemcapActionLine("[2026-09-28 16:37:36] watch: alive (memcap 0.17.1)")).toBe(false);
  expect(isMemcapActionLine("[2026-09-28 16:37:40] tier3: declining -- active mobile tooling detected")).toBe(false);
  expect(isMemcapActionLine("[2026-09-28 16:37:40] tier3: reclaimed nothing -- 408 sim pid(s)")).toBe(false);
  expect(isMemcapActionLine("[2026-09-28 16:37:47] measure: top had no row for 130 processes")).toBe(false);
  expect(isMemcapActionLine("[2026-09-29 20:35:11] tier3: pid 1 is a live agent session's own process -- holding it to 1800s")).toBe(false);
  expect(isMemcapActionLine("[2026-09-29 22:48:15] pressure: disk available 9.98 GB, swap used 4.16 GB")).toBe(false);
  expect(isMemcapActionLine("[2026-09-29 23:50:10] watch: combined 32.20 GB exceeds the adaptive 32 GB planning target")).toBe(false);
  expect(isMemcapActionLine("[2026-09-29 23:39:28] tier1 orphan:  1196  12544 bun serve.ts")).toBe(true);
  expect(isMemcapActionLine("[2026-09-28 16:40:00] tier3: xcrun simctl shutdown ABC (iPhone) -- idle")).toBe(true);
  expect(isMemcapActionLine("[2026-09-28 16:40:00] tier3: reclaiming pid 42 -- idle 700s")).toBe(true);
});

test("the guard launch agent runs every minute and at load", () => {
  const home = "/Users/test";
  const plist = renderWatcherLaunchAgent({
    mode: "guard",
    paths: macWatcherPaths(home),
    bun: "/Users/test/.bun/bin/bun",
    script: "/repo/src/commands/mac-watcher.ts",
    home,
  });
  expect(plist).toContain(`<string>${MAC_WATCHER.guardLabel}</string>`);
  expect(plist).toContain("<string>guard</string>");
  expect(plist).toContain("<key>StartInterval</key><integer>60</integer>");
  expect(plist).not.toContain("StartCalendarInterval");
  expect(Bun.spawnSync(["plutil", "-lint", "-"], { stdin: Buffer.from(plist) }).exitCode).toBe(0);
});
