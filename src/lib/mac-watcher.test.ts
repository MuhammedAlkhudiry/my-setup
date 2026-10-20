import { expect, test } from "bun:test";

import { MAC_WATCHER, MEMCAP_CONFIG } from "../../config/mac-watcher";
import { STUCK_RUN_NOTE } from "./cpu-guard";
import {
  type Alert,
  type AlertInput,
  isMemcapActionLine,
  macWatcherPaths,
  mergeAlerts,
  parseDaemonFootprints,
  parseListeners,
  pruneAlerts,
  renderMemcapConfig,
  renderWatcherLaunchAgent,
  sharedPorts,
  thresholdAlerts,
} from "./mac-watcher";

const quiet: AlertInput = {
  pressureLevel: "normal",
  swapUsedGib: 1,
  diskFreeGib: 200,
  largestDiskUsers: [],
  loadAverage15: 6,
  cores: 14,
  orphans: [],
  sustainedCpu: [],
  systemDaemons: [],
  guardStops: [],
  memcapHealthy: true,
  sharedPorts: [],
};

const keys = (input: Partial<AlertInput>) =>
  thresholdAlerts({ ...quiet, ...input }).map((alert) => alert.key);

const leak = {
  key: "playwright-orphans",
  severity: "warning" as const,
  title: "Playwright browsers outlive their MCP server",
  evidence: "4 orphaned Chrome for Testing roots",
  fix: "Update Playwright MCP",
};

test("a healthy machine raises no alerts", () => {
  expect(thresholdAlerts(quiet)).toEqual([]);
});

test("runaway root daemon memory alerts even without memory pressure or swap", () => {
  const daemon = {
    pid: 343,
    command: "/System/Library/Frameworks/FSEvents.framework/Support/fseventsd",
    started: "Sun Sep 27 16:38:22 2026",
    rssMib: 13 * 1024,
    footprintMib: 22 * 1024,
    cpuNow: 103.8,
    ageMinutes: 19 * 24 * 60,
  };
  const observed = thresholdAlerts({ ...quiet, systemDaemons: [daemon] });

  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ key: "system-daemon-memory-343", severity: "warning" });
  expect(observed[0]?.evidence).toContain("22.0 GiB footprint");
  expect(observed[0]?.evidence).toContain("13.0 GiB RSS");
  expect(observed[0]?.evidence).toContain("103.8% CPU");
  expect(observed[0]?.evidence).toContain("27360 min");

  const opened = mergeAlerts([], observed, "before-restart");
  const clear = thresholdAlerts({
    ...quiet,
    systemDaemons: [{ ...daemon, rssMib: 50, footprintMib: 80 }],
  });
  const once = mergeAlerts(opened.alerts, clear, "after-restart");
  expect(mergeAlerts(once.alerts, clear, "next-run").resolved).toHaveLength(1);
});

test("daemon limits are strict, use footprint when available, and otherwise fall back to RSS", () => {
  const daemon = (pid: number, command: string, rssMib: number, footprintMib?: number) => ({
    pid,
    command,
    rssMib,
    footprintMib,
    started: "boot",
    cpuNow: 0,
    ageMinutes: 10,
  });
  expect(
    keys({
      systemDaemons: [
        daemon(1, "/System/Library/fseventsd", 2048),
        daemon(2, "/usr/libexec/other", 4096),
        daemon(3, "/usr/sbin/other", 4096),
      ],
    }),
  ).toEqual([]);
  expect(
    keys({
      systemDaemons: [
        daemon(1, "/System/Library/fseventsd", 2049),
        daemon(2, "/usr/libexec/other", 100, 4097),
        daemon(3, "/usr/sbin/other", 4097),
        daemon(4, "/System/Library/other", 4097),
        daemon(5, "/Users/test/fseventsd", 9000),
        daemon(6, "/usr/libexec-other/tool", 9000),
      ],
    }),
  ).toEqual([
    "system-daemon-memory-1",
    "system-daemon-memory-2",
    "system-daemon-memory-3",
    "system-daemon-memory-4",
  ]);
});

test("top footprint parsing handles compressed footprints, unit suffixes, and unavailable rows", () => {
  expect([
    ...parseDaemonFootprints(
      [
        "Processes: 1280 total",
        "PID MEM",
        "343 25G",
        "1 29M",
        "2 1.5G+",
        "3 1024K-",
        "4 1024B",
        "5 2048",
        "6 N/A",
        "7 ???",
      ].join("\n"),
    ),
  ]).toEqual([
    [343, 25600],
    [1, 29],
    [2, 1536],
    [3, 1],
    [4, 1 / 1024],
    [5, 2 / 1024],
  ]);
});

test("each crossed threshold opens its own stable alert", () => {
  const busy = { command: "qemu-system-aarch64 -avd Awraq_Main", ageMinutes: 600, cpuLifetime: 90 };

  expect(keys({ diskFreeGib: 15 })).toEqual([]);
  expect(keys({ diskFreeGib: 9 })).toEqual(["low-disk"]);
  expect(keys({ pressureLevel: "warning" })).toEqual([]);
  expect(keys({ pressureLevel: "critical" })).toEqual(["memory-pressure"]);
  expect(keys({ swapUsedGib: 13, swapTotalGib: 14 })).toEqual([]);
  expect(keys({ swapUsedGib: 13, swapTotalGib: 14, pressureLevel: "warning" })).toEqual([
    "high-swap",
  ]);
  expect(keys({ swapUsedGib: 8, swapTotalGib: 14, pressureLevel: "warning" })).toEqual([]);
  expect(keys({ loadAverage15: 100 })).toEqual([]);
  expect(keys({ orphans: [busy] })).toEqual(["orphaned-agent-processes"]);
  expect(keys({ sustainedCpu: [busy] })).toEqual(["sustained-cpu"]);
  expect(keys({ guardStops: ["stopped pid 1"] })).toEqual(["cpu-guard-stops"]);
  expect(keys({ memcapHealthy: false })).toEqual(["memcap-unhealthy"]);
});

test("a stopped watcher run raises its own warning apart from stopped leftovers", () => {
  const stuck = `stopped pid 2 -- ${STUCK_RUN_NOTE} for 61 min, in step ".codex/sessions" since 2026-10-11T18:08:00.000Z`;
  const alerts = thresholdAlerts({
    ...quiet,
    guardStops: ["stopped pid 1 -- leftover idle", stuck],
  });

  expect(alerts.map((alert) => [alert.key, alert.severity, alert.evidence])).toEqual([
    ["watcher-run-stuck", "warning", stuck],
    ["cpu-guard-stops", "info", "stopped pid 1 -- leftover idle"],
  ]);
});

test("disk alerts open below 10 GiB and name the largest disk users", () => {
  const largestDiskUsers = [{ path: "~/.t3/worktrees/app", gib: 150 }];
  const [warning] = thresholdAlerts({ ...quiet, diskFreeGib: 9, largestDiskUsers });
  const [critical] = thresholdAlerts({ ...quiet, diskFreeGib: 5 });

  expect(warning).toMatchObject({
    severity: "critical",
    evidence: "largest disk users: ~/.t3/worktrees/app 150G",
  });
  expect(critical?.severity).toBe("critical");
});

test("an alert opens, stays open while seen, and closes after enough clear runs", () => {
  const first = mergeAlerts([], [leak], "t1", 2);
  expect(first.opened.map((alert) => alert.key)).toEqual(["playwright-orphans"]);

  const seenAgain = mergeAlerts(first.alerts, [leak], "t2", 2);
  expect(seenAgain.opened).toEqual([]);
  expect(seenAgain.alerts[0]).toMatchObject({ status: "open", seenCount: 2, clearReviews: 0 });

  const clearOnce = mergeAlerts(seenAgain.alerts, [], "t3", 2);
  expect(clearOnce.alerts[0]).toMatchObject({ status: "open", clearReviews: 1 });

  const clearTwice = mergeAlerts(clearOnce.alerts, [], "t4", 2);
  expect(clearTwice.resolved.map((alert) => alert.key)).toEqual(["playwright-orphans"]);
  expect(clearTwice.alerts[0]).toMatchObject({
    status: "resolved",
    resolvedBy: "auto",
    resolvedAt: "t4",
  });
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
  if (process.platform === "darwin") {
    expect(Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(config) }).exitCode).toBe(0);
  }
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
  if (process.platform === "darwin") {
    expect(Bun.spawnSync(["plutil", "-lint", "-"], { stdin: Buffer.from(plist) }).exitCode).toBe(0);
  }
});

test("routine memcap lines do not count as actions", () => {
  expect(isMemcapActionLine("[2026-09-28 16:37:36] watch: alive (memcap 0.17.1)")).toBe(false);
  expect(
    isMemcapActionLine("[2026-09-28 16:37:40] tier3: declining -- active mobile tooling detected"),
  ).toBe(false);
  expect(
    isMemcapActionLine("[2026-09-28 16:37:40] tier3: reclaimed nothing -- 408 sim pid(s)"),
  ).toBe(false);
  expect(
    isMemcapActionLine("[2026-09-28 16:37:47] measure: top had no row for 130 processes"),
  ).toBe(false);
  expect(
    isMemcapActionLine(
      "[2026-09-29 20:35:11] tier3: pid 1 is a live agent session's own process -- holding it to 1800s",
    ),
  ).toBe(false);
  expect(
    isMemcapActionLine("[2026-09-29 22:48:15] pressure: disk available 9.98 GB, swap used 4.16 GB"),
  ).toBe(false);
  expect(
    isMemcapActionLine(
      "[2026-09-29 23:50:10] watch: combined 32.20 GB exceeds the adaptive 32 GB planning target",
    ),
  ).toBe(false);
  expect(isMemcapActionLine("[2026-09-29 23:39:28] tier1 orphan:  1196  12544 bun serve.ts")).toBe(
    true,
  );
  expect(
    isMemcapActionLine("[2026-09-28 16:40:00] tier3: xcrun simctl shutdown ABC (iPhone) -- idle"),
  ).toBe(true);
  expect(isMemcapActionLine("[2026-09-28 16:40:00] tier3: reclaiming pid 42 -- idle 700s")).toBe(
    true,
  );
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
  if (process.platform === "darwin") {
    expect(Bun.spawnSync(["plutil", "-lint", "-"], { stdin: Buffer.from(plist) }).exitCode).toBe(0);
  }
});

test("a port two unrelated processes listen on is reported, but a parent's inherited socket is not", () => {
  const listeners = parseListeners(
    [
      "p9756",
      "credis-server",
      "f6",
      "n*:6379",
      "f7",
      "n[::1]:6379",
      "p61280",
      "credis-server",
      "f6",
      "n127.0.0.1:6379",
      "p65051",
      "cnginx",
      "f6",
      "n127.0.0.1:80",
      "p65055",
      "cnginx",
      "f6",
      "n127.0.0.1:80",
      "p94307",
      "cnginx-arm64",
      "f6",
      "n127.0.0.1:443",
      "p94308",
      "cnginx-arm64",
      "f6",
      "n127.0.0.1:443",
    ].join("\n"),
  );
  const parentOf = new Map([
    [9756, 1],
    [61280, 724],
    [724, 1],
    [65051, 724],
    [65055, 65051],
    // Workers of a root nginx master, which a non-root lsof doesn't list.
    [94307, 94306],
    [94308, 94306],
    [94306, 1],
  ]);

  expect(sharedPorts(listeners, parentOf)).toEqual([
    { port: 6379, processes: ["redis-server (9756)", "redis-server (61280)"] },
  ]);
  expect(keys({ sharedPorts: sharedPorts(listeners, parentOf) })).toContain("shared-ports");
});
