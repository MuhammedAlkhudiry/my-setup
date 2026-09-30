import { expect, test } from "bun:test";

import {
  type ProcessRow,
  isOrphanedAgentTooling,
  parseCpuTime,
  parseEtime,
  parsePsOutput,
  stepGuard,
  sustainedCpuProcesses,
} from "./cpu-guard";

const UID = 501;
const STARTED = "Wed Sep 30 09:00:00 2026";

function row(overrides: Partial<ProcessRow>): ProcessRow {
  return {
    pid: 100,
    ppid: 1,
    uid: UID,
    rssMib: 300,
    cpuPercent: 0,
    cpuSeconds: 0,
    ageSeconds: 3600,
    started: STARTED,
    command: "/Users/test/.cache/ms-playwright/chromium-1234/chrome-mac/Chromium --headless",
    ...overrides,
  };
}

const options = { hotPercent: 80, stopAfterMinutes: 10 };
const MINUTE = 60_000;

test("ps times parse into seconds", () => {
  expect(parseEtime("05:03")).toBe(303);
  expect(parseEtime("01-02:03:04")).toBe(93784);
  expect(parseCpuTime("821:17.29")).toBeCloseTo(49277.29);
  expect(parseCpuTime("1-00:00:01.50")).toBeCloseTo(86401.5);
});

test("ps output keeps the multi-word start time and the full command", () => {
  const [parsed] = parsePsOutput(
    "17466     1   501 2860000 103.4 821:17.29 14:45:32 Tue Sep 29 18:37:41 2026     /path/qemu-system-aarch64 -avd Awraq_Main",
  );
  expect(parsed).toMatchObject({
    pid: 17466,
    ppid: 1,
    uid: 501,
    cpuPercent: 103.4,
    ageSeconds: 53132,
    started: "Tue Sep 29 18:37:41 2026",
    command: "/path/qemu-system-aarch64 -avd Awraq_Main",
  });
});

test("only this user's leftover agent tooling is a guard target", () => {
  expect(isOrphanedAgentTooling(row({}), UID)).toBe(true);
  expect(isOrphanedAgentTooling(row({ command: "node ./node_modules/.bin/vite" }), UID)).toBe(true);
  expect(isOrphanedAgentTooling(row({ ppid: 4242 }), UID)).toBe(false);
  expect(isOrphanedAgentTooling(row({ uid: 0 }), UID)).toBe(false);
  expect(isOrphanedAgentTooling(row({ command: "/path/emulator/qemu-system-aarch64 -avd vite" }), UID)).toBe(false);
  expect(isOrphanedAgentTooling(row({ command: "/Applications/Some mcp.app/Contents/MacOS/Some" }), UID)).toBe(false);
  expect(isOrphanedAgentTooling(row({ command: "/Users/test/.local/bin/codex mcp-server" }), UID)).toBe(false);
  expect(isOrphanedAgentTooling(row({ command: "/usr/libexec/diagnosticd" }), UID)).toBe(false);
});

test("a leftover is stopped only after staying hot for the whole window", () => {
  let state = stepGuard({ tracked: {} }, [row({ cpuSeconds: 0 })], UID, 0, options).next;
  let cpuSeconds = 0;
  for (let minute = 1; minute <= 9; minute += 1) {
    cpuSeconds += 55;
    const step = stepGuard(state, [row({ cpuSeconds })], UID, minute * MINUTE, options);
    expect(step.stop).toEqual([]);
    state = step.next;
  }
  cpuSeconds += 55;
  const step = stepGuard(state, [row({ cpuSeconds })], UID, 10 * MINUTE, options);
  expect(step.stop).toHaveLength(1);
  expect(step.stop[0]).toMatchObject({ percent: 92, hotMinutes: 10 });
});

test("a cool minute or a reused pid restarts the window", () => {
  const hot = stepGuard(
    { tracked: { "100": { started: STARTED, cpuSeconds: 0, sampledAt: 0, hotSince: 0 } } },
    [row({ cpuSeconds: 10 })],
    UID,
    11 * MINUTE,
    options,
  );
  expect(hot.stop).toEqual([]);
  expect(hot.next.tracked["100"].hotSince).toBeUndefined();

  const reused = stepGuard(
    { tracked: { "100": { started: "Mon Sep 28 08:00:00 2026", cpuSeconds: 0, sampledAt: 0, hotSince: 0 } } },
    [row({ cpuSeconds: 10_000 })],
    UID,
    11 * MINUTE,
    options,
  );
  expect(reused.stop).toEqual([]);
});

test("busy devices are reported as sustained CPU users, never as guard targets", () => {
  const emulator = row({
    pid: 17466,
    command: "/path/emulator/qemu-system-aarch64 -avd Awraq_Main",
    cpuSeconds: 49_000,
    ageSeconds: 53_000,
  });
  const idle = row({ pid: 2, cpuSeconds: 10, ageSeconds: 53_000 });
  const young = row({ pid: 3, cpuSeconds: 600, ageSeconds: 600 });
  expect(sustainedCpuProcesses([idle, young, emulator], 80, 30).map((entry) => entry.pid)).toEqual([17466]);
  expect(stepGuard({ tracked: {} }, [emulator], UID, 0, options).next.tracked).toEqual({});
});
