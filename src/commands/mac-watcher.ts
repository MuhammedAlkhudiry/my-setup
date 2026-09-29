#!/usr/bin/env bun

/**
 * Scheduled Mac resource review. `run` is started by the watcher LaunchAgent; `status` and `resolve` are for people.
 *
 * Each run collects a snapshot without AI, and asks Codex for a fresh, read-only review only when something looks wrong,
 * alerts are open, or the daily memory refresh is due. Memory between runs lives in the watcher state directory.
 */

import { existsSync, readFileSync, statfsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import { MAC_WATCHER, MEMCAP_LAUNCH_AGENT_LABEL } from "../../config/mac-watcher";
import {
  type Alert,
  type GateInput,
  type Review,
  REVIEW_JSON_SCHEMA,
  fileAgeSeconds,
  isLaunchAgentLoaded,
  isMemcapActionLine,
  macWatcherPaths,
  mergeAlerts,
  pruneAlerts,
  readAlerts,
  readState,
  reviewReasons,
  reviewSchema,
  writeJson,
} from "../lib/mac-watcher";

const ROOT_DIR = join(import.meta.dir, "..", "..");
const HOME = process.env.HOME || "";
const paths = macWatcherPaths(HOME);
const GIB = 1024 ** 3;
const MEMCAP_STALE_SECONDS = 600;
const MAX_LOG_LINES = 80;
const TEMP_DIR = process.env.TMPDIR || "/tmp";

// =============================================================================
// Snapshot
// =============================================================================

async function run(command: string, args: string[], timeout = 20_000): Promise<string> {
  const result = await execa(command, args, { reject: false, timeout });
  return result.exitCode === 0 ? result.stdout : "";
}

function parseEtime(value: string): number {
  const [days, rest] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts;
  return Number(days) * 86400 + hours * 3600 + minutes * 60 + seconds;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  rssMib: number;
  ageMinutes: number;
  command: string;
}

const FAMILIES: Array<[name: string, pattern: RegExp]> = [
  ["Chrome for Testing / Playwright", /Chrome for Testing|ms-playwright|chrome-headless-shell/],
  ["Google Chrome", /Google Chrome\.app/],
  ["iOS Simulator", /CoreSimulator|launchd_sim|Simulator\.app/],
  ["Android emulator", /qemu-system|emulator64|\/emulator\/emulator/],
  ["Xcode", /Xcode\.app/],
  ["Maestro", /maestro/i],
  ["Codex", /codex/i],
  ["Claude Code", /claude/i],
  ["T3 Code", /T3 Code/],
  ["Node / Bun", /(^|\/)(node|bun)( |$)/],
];

const ORPHAN_PATTERN =
  /Chrome for Testing|ms-playwright|chrome-headless-shell|chrome-devtools-mcp|playwright|\bmcp\b|-mcp|vite|next dev|webpack|esbuild|nodemon|\btsx\b|expo start|metro/i;

async function listProcesses(): Promise<ProcessRow[]> {
  const output = await run("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="]);
  return output
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssMib: Math.round(Number(match[3]) / 1024),
      ageMinutes: Math.round(parseEtime(match[4]) / 60),
      command: match[5],
    }));
}

function shortCommand(command: string): string {
  return command.replace(HOME, "~").slice(0, 160);
}

async function readNewMemcapLines(offset: number): Promise<{ lines: string[]; offset: number }> {
  if (!existsSync(paths.memcapActionsLog)) return { lines: [], offset: 0 };
  const handle = await open(paths.memcapActionsLog, "r");
  try {
    const { size } = await handle.stat();
    // A rotated or truncated log starts over from the beginning.
    const start = offset > size ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    return { lines, offset: size };
  } finally {
    await handle.close();
  }
}

/** Largest temp entries; agent clones and QA copies there filled the disk once. Measured only when disk is low. */
async function largestTempEntries(): Promise<Array<{ path: string; gib: number }>> {
  const output = await run("sh", ["-c", 'du -sk "$0"/* 2>/dev/null | sort -rn | head -8', TEMP_DIR], 180_000);
  return output
    .split("\n")
    .map((line) => line.match(/^(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ path: shortCommand(match[2]), gib: Number((Number(match[1]) / 1024 ** 2).toFixed(1)) }));
}

async function collectSnapshot(memcapLogOffset: number) {
  const [pressureText, pressureLevelText, swapText, processes, simsJson, adbText, memcapStatus] = await Promise.all([
    run("memory_pressure", []),
    run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    run("sysctl", ["-n", "vm.swapusage"]),
    listProcesses(),
    run("xcrun", ["simctl", "list", "devices", "booted", "-j"]),
    Bun.which("adb") ? run("adb", ["devices"]) : Promise.resolve(""),
    Bun.which("memcap") ? run("memcap", ["status"], 30_000) : Promise.resolve(""),
  ]);

  const freePercent = Number(pressureText.match(/free percentage: (\d+)%/)?.[1]);
  const pressureLevel = ({ "1": "normal", "2": "warning", "4": "critical" } as const)[
    pressureLevelText.trim() as "1" | "2" | "4"
  ] ?? "unknown";
  const swapUsedGib = Number(swapText.match(/used = ([\d.]+)M/)?.[1] ?? 0) / 1024;
  const disk = statfsSync(HOME);
  const diskFreeGib = (disk.bavail * disk.bsize) / GIB;
  const largestTemp = diskFreeGib < MAC_WATCHER.gate.minDiskFreeGib ? await largestTempEntries() : [];

  const families = new Map<string, { processes: number; rssMib: number }>();
  for (const row of processes) {
    const family = FAMILIES.find(([, pattern]) => pattern.test(row.command))?.[0] ?? "Other";
    const entry = families.get(family) ?? { processes: 0, rssMib: 0 };
    entry.processes += 1;
    entry.rssMib += row.rssMib;
    families.set(family, entry);
  }

  const orphans = processes
    .filter(
      (row) =>
        row.ppid === 1 &&
        row.ageMinutes >= MAC_WATCHER.gate.orphanMinAgeMinutes &&
        ORPHAN_PATTERN.test(row.command) &&
        !/Google Chrome\.app|\.app\/Contents\/MacOS\/[^/]+$/.test(row.command),
    )
    .map((row) => ({ ...row, command: shortCommand(row.command) }));

  let bootedSimulators: string[] = [];
  try {
    const devices = JSON.parse(simsJson || "{}").devices ?? {};
    bootedSimulators = Object.entries(devices).flatMap(([runtime, list]) =>
      (list as Array<{ name: string }>).map((device) => `${device.name} (${runtime.split(".").pop()})`),
    );
  } catch {
    bootedSimulators = [];
  }
  const emulators = adbText.split("\n").filter((line) => line.startsWith("emulator-"));

  const memcapAge = fileAgeSeconds(paths.memcapLastPass);
  const memcapLog = await readNewMemcapLines(memcapLogOffset);
  const memcap = {
    installed: Boolean(Bun.which("memcap")),
    serviceLoaded: await isLaunchAgentLoaded(MEMCAP_LAUNCH_AGENT_LABEL),
    paused: existsSync(paths.memcapPaused),
    secondsSinceLastPass: memcapAge === undefined ? undefined : Math.round(memcapAge),
    newLogLines: memcapLog.lines.slice(-MAX_LOG_LINES),
    newLogLineCount: memcapLog.lines.length,
    actionLineCount: memcapLog.lines.filter(isMemcapActionLine).length,
    status: memcapStatus.split("\n").slice(0, 40).join("\n"),
  };

  return {
    snapshot: {
      takenAt: new Date().toISOString(),
      memory: {
        freePercent: Number.isNaN(freePercent) ? undefined : freePercent,
        pressureLevel,
        swapUsedGib: Number(swapUsedGib.toFixed(2)),
      },
      diskFreeGib: Number(diskFreeGib.toFixed(1)),
      largestTemp,
      families: [...families.entries()]
        .map(([name, value]) => ({ name, ...value }))
        .sort((a, b) => b.rssMib - a.rssMib),
      topProcesses: [...processes]
        .sort((a, b) => b.rssMib - a.rssMib)
        .slice(0, 15)
        .map((row) => ({ ...row, command: shortCommand(row.command) })),
      orphans: orphans.slice(0, 30),
      orphanCount: orphans.length,
      bootedSimulators,
      emulators,
      memcap,
    },
    memcapLogOffset: memcapLog.offset,
  };
}

type Snapshot = Awaited<ReturnType<typeof collectSnapshot>>["snapshot"];

function memcapHealthy(snapshot: Snapshot): boolean {
  const { memcap } = snapshot;
  return (
    memcap.installed &&
    memcap.serviceLoaded &&
    !memcap.paused &&
    memcap.secondsSinceLastPass !== undefined &&
    memcap.secondsSinceLastPass < MEMCAP_STALE_SECONDS
  );
}

// =============================================================================
// Codex review
// =============================================================================

async function reviewWithCodex(snapshot: Snapshot, patterns: string[], openAlerts: Alert[]): Promise<Review> {
  const instructions = readFileSync(join(ROOT_DIR, "config/mac-watcher-prompt.md"), "utf8");
  const prompt = [
    instructions,
    "## Learned patterns",
    patterns.length > 0 ? patterns.map((pattern) => `- ${pattern}`).join("\n") : "None yet.",
    "## Open alerts",
    openAlerts.length > 0
      ? JSON.stringify(
          openAlerts.map(({ key, severity, title, evidence, fix, firstSeen, seenCount }) => ({
            key,
            severity,
            title,
            evidence,
            fix,
            firstSeen,
            seenCount,
          })),
          null,
          2,
        )
      : "None.",
    "## Snapshot",
    JSON.stringify(snapshot, null, 2),
  ].join("\n\n");

  await writeJson(paths.outputSchema, REVIEW_JSON_SCHEMA);
  const { codex } = MAC_WATCHER;
  await execa(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--sandbox",
      "read-only",
      "--model",
      codex.model,
      "--config",
      `model_reasoning_effort="${codex.reasoningEffort}"`,
      "--output-schema",
      paths.outputSchema,
      "--output-last-message",
      paths.codexOutput,
      "--cd",
      paths.stateDir,
      "-",
    ],
    { input: prompt, timeout: codex.timeoutMs, stdout: "ignore", stderr: "pipe" },
  );
  const review = reviewSchema.parse(JSON.parse(readFileSync(paths.codexOutput, "utf8")));
  return { ...review, patterns: review.patterns.slice(0, MAC_WATCHER.patternLimit) };
}

async function notify(alert: Alert): Promise<void> {
  const script = `display notification ${JSON.stringify(alert.fix)} with title ${JSON.stringify(
    `Mac watcher: ${alert.title}`,
  )}`;
  await execa("osascript", ["-e", script], { reject: false });
}

// =============================================================================
// Commands
// =============================================================================

async function runOnce(force: boolean): Promise<void> {
  const state = readState(paths);
  const now = new Date();
  const at = now.toISOString();
  state.lastRunAt = at;

  try {
    const alerts = readAlerts(paths);
    const openAlerts = alerts.filter((alert) => alert.status === "open");
    const { snapshot, memcapLogOffset } = await collectSnapshot(state.memcapLogOffset);
    await writeJson(paths.lastSnapshot, snapshot);

    const gate: GateInput = {
      freePercent: snapshot.memory.freePercent,
      pressureLevel: snapshot.memory.pressureLevel,
      swapUsedGib: snapshot.memory.swapUsedGib,
      diskFreeGib: snapshot.diskFreeGib,
      newOrphanCount: snapshot.orphans.filter((orphan) => !state.seenOrphanPids.includes(orphan.pid)).length,
      memcapActionLines: snapshot.memcap.actionLineCount,
      memcapHealthy: memcapHealthy(snapshot),
      hoursSinceReview: state.lastReviewAt
        ? (now.getTime() - Date.parse(state.lastReviewAt)) / 3_600_000
        : undefined,
    };
    const reasons = force ? ["manual run"] : reviewReasons(gate);

    let note = "Quiet run; no review needed.";
    if (reasons.length > 0) {
      const review = await reviewWithCodex(snapshot, state.patterns, openAlerts);
      const merged = mergeAlerts(alerts, review.alerts, at);
      await writeJson(paths.alerts, pruneAlerts(merged.alerts, now));
      for (const alert of merged.opened) {
        if (alert.severity !== "info") await notify(alert);
      }
      state.patterns = review.patterns;
      state.lastReviewAt = at;
      note = review.runNote;
      console.log(
        `[${at}] reviewed (${reasons.join(", ")}): ${note} opened=${merged.opened.length} resolved=${merged.resolved.length}`,
      );
    } else {
      console.log(`[${at}] ${note}`);
    }

    state.memcapLogOffset = memcapLogOffset;
    state.seenOrphanPids = snapshot.orphans.map((orphan) => orphan.pid);
    state.runs = [...state.runs, { at, reviewed: reasons.length > 0, reasons, note }].slice(
      -MAC_WATCHER.historyLimit,
    );
    state.lastSuccessAt = at;
    state.lastError = undefined;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error);
    console.error(`[${at}] failed: ${state.lastError}`);
    process.exitCode = 1;
  } finally {
    await writeJson(paths.state, state);
  }
}

function printStatus(): void {
  const state = readState(paths);
  const alerts = readAlerts(paths);
  const open = alerts.filter((alert) => alert.status === "open");
  console.log(`Last run: ${state.lastRunAt ?? "never"}`);
  console.log(`Last success: ${state.lastSuccessAt ?? "never"}`);
  console.log(`Last Codex review: ${state.lastReviewAt ?? "never"}`);
  if (state.lastError) console.log(`Last error: ${state.lastError}`);
  console.log(`\nOpen alerts (${open.length}):`);
  for (const alert of open) {
    console.log(`- [${alert.severity}] ${alert.key}: ${alert.title}\n  evidence: ${alert.evidence}\n  fix: ${alert.fix}`);
  }
  console.log(`\nLearned patterns (${state.patterns.length}):`);
  for (const pattern of state.patterns) console.log(`- ${pattern}`);
  console.log("\nRecent runs:");
  for (const entry of state.runs.slice(-10)) {
    console.log(`- ${entry.at} ${entry.reviewed ? "reviewed" : "quiet"}: ${entry.note}`);
  }
}

async function resolveAlert(key: string | undefined): Promise<void> {
  if (!key) throw new Error("usage: mac-watcher resolve <alert-key>");
  const alerts = readAlerts(paths);
  const alert = alerts.find((candidate) => candidate.key === key && candidate.status === "open");
  if (!alert) throw new Error(`No open alert named ${key}`);
  alert.status = "resolved";
  alert.resolvedAt = new Date().toISOString();
  alert.resolvedBy = "manual";
  await writeJson(paths.alerts, alerts);
  console.log(`Resolved ${key}. It reopens if the watcher sees it again.`);
}

const [command = "status", ...args] = process.argv.slice(2);
switch (command) {
  case "run":
    await runOnce(args.includes("--force"));
    break;
  case "status":
    printStatus();
    break;
  case "resolve":
    await resolveAlert(args[0]);
    break;
  default:
    console.error("usage: mac-watcher run [--force] | status | resolve <alert-key>");
    process.exitCode = 2;
}
