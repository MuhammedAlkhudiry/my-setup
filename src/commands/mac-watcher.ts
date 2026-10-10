#!/usr/bin/env bun

/**
 * Mac resource watcher. `run` is the scheduled pass and `guard` the minute-by-minute CPU guard, each started by its own
 * LaunchAgent; `status`, `resolve`, `prune`, and `review` are for people.
 *
 * Each run frees disk with the fixed storage rules, takes a snapshot, and opens or closes threshold alerts, all without AI.
 * `review` asks Codex for a read-only diagnosis of a fresh snapshot and stores nothing.
 */

import { existsSync, readFileSync, statfsSync } from "node:fs";
import { appendFile, open } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import { MAC_WATCHER, MEMCAP_LAUNCH_AGENT_LABEL } from "../../config/mac-watcher";
import {
  type GuardState,
  guardStateSchema,
  isOrphanedAgentTooling,
  lifetimeCpuPercent,
  listProcesses,
  stepGuard,
  sustainedCpuProcesses,
} from "../lib/cpu-guard";
import {
  type Alert,
  type Review,
  REVIEW_JSON_SCHEMA,
  fileAgeSeconds,
  isLaunchAgentLoaded,
  isMemcapActionLine,
  macWatcherPaths,
  mergeAlerts,
  parseListeners,
  pruneAlerts,
  readAlerts,
  readState,
  reviewSchema,
  sharedPorts,
  thresholdAlerts,
  writeJson,
} from "../lib/mac-watcher";
import { pruneStorage, summarizePrune } from "../lib/storage-prune";

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

function shortCommand(command: string): string {
  return command.replace(HOME, "~").slice(0, 160);
}

async function readNewLines(path: string, offset: number): Promise<{ lines: string[]; offset: number }> {
  if (!existsSync(path)) return { lines: [], offset: 0 };
  const handle = await open(path, "r");
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

async function collectSnapshot(memcapLogOffset: number, guardLogOffset: number) {
  const [pressureText, pressureLevelText, swapText, processes, simsJson, adbText, memcapStatus, listenersText] =
    await Promise.all([
    run("memory_pressure", []),
    run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    run("sysctl", ["-n", "vm.swapusage"]),
    listProcesses(),
    run("xcrun", ["simctl", "list", "devices", "booted", "-j"]),
    Bun.which("adb") ? run("adb", ["devices"]) : Promise.resolve(""),
    Bun.which("memcap") ? run("memcap", ["status"], 30_000) : Promise.resolve(""),
    run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]),
  ]);

  const freePercent = Number(pressureText.match(/free percentage: (\d+)%/)?.[1]);
  const pressureLevel = ({ "1": "normal", "2": "warning", "4": "critical" } as const)[
    pressureLevelText.trim() as "1" | "2" | "4"
  ] ?? "unknown";
  const swapUsedGib = Number(swapText.match(/used = ([\d.]+)M/)?.[1] ?? 0) / 1024;
  const disk = statfsSync(HOME);
  const diskFreeGib = (disk.bavail * disk.bsize) / GIB;
  const largestTemp = diskFreeGib < MAC_WATCHER.thresholds.minDiskFreeGib ? await largestTempEntries() : [];

  const families = new Map<string, { processes: number; rssMib: number }>();
  for (const row of processes) {
    const family = FAMILIES.find(([, pattern]) => pattern.test(row.command))?.[0] ?? "Other";
    const entry = families.get(family) ?? { processes: 0, rssMib: 0 };
    entry.processes += 1;
    entry.rssMib += row.rssMib;
    families.set(family, entry);
  }

  const uid = process.getuid?.() ?? 0;
  const orphans = processes
    .filter(
      (row) =>
        isOrphanedAgentTooling(row, uid) && row.ageSeconds >= MAC_WATCHER.thresholds.orphanMinAgeMinutes * 60,
    )
    .map((row) => ({
      pid: row.pid,
      rssMib: row.rssMib,
      ageMinutes: Math.round(row.ageSeconds / 60),
      command: shortCommand(row.command),
    }));

  const parentOf = new Map(processes.map((row) => [row.pid, row.ppid]));
  const ports = sharedPorts(parseListeners(listenersText), parentOf);

  const [load1, load5, load15] = loadavg();
  const cpuSummary = (row: (typeof processes)[number]) => ({
    pid: row.pid,
    cpuNow: row.cpuPercent,
    cpuLifetime: Math.round(lifetimeCpuPercent(row)),
    ageMinutes: Math.round(row.ageSeconds / 60),
    rssMib: row.rssMib,
    command: shortCommand(row.command),
  });
  const guardLog = await readNewLines(paths.guardLog, guardLogOffset);
  const cpu = {
    cores: cpus().length,
    loadAverage: [load1, load5, load15].map((value) => Number(value.toFixed(2))),
    topNow: [...processes]
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 10)
      .map(cpuSummary),
    sustained: sustainedCpuProcesses(processes).slice(0, 15).map(cpuSummary),
    guardStops: guardLog.lines.slice(-MAX_LOG_LINES),
  };

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
  const memcapLog = await readNewLines(paths.memcapActionsLog, memcapLogOffset);
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
      cpu,
      diskFreeGib: Number(diskFreeGib.toFixed(1)),
      largestTemp,
      families: [...families.entries()]
        .map(([name, value]) => ({ name, ...value }))
        .sort((a, b) => b.rssMib - a.rssMib),
      topProcesses: [...processes]
        .sort((a, b) => b.rssMib - a.rssMib)
        .slice(0, 15)
        .map((row) => ({
          pid: row.pid,
          rssMib: row.rssMib,
          ageMinutes: Math.round(row.ageSeconds / 60),
          command: shortCommand(row.command),
        })),
      orphans: orphans.slice(0, 30),
      orphanCount: orphans.length,
      sharedPorts: ports,
      bootedSimulators,
      emulators,
      memcap,
    },
    memcapLogOffset: memcapLog.offset,
    guardLogOffset: guardLog.offset,
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

async function reviewWithCodex(snapshot: Snapshot, openAlerts: Alert[]): Promise<Review> {
  const instructions = readFileSync(join(ROOT_DIR, "config/mac-watcher-prompt.md"), "utf8");
  const prompt = [
    instructions,
    "## Open threshold alerts",
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
  return reviewSchema.parse(JSON.parse(readFileSync(paths.codexOutput, "utf8")));
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

async function runOnce(): Promise<void> {
  const state = readState(paths);
  const now = new Date();
  const at = now.toISOString();
  state.lastRunAt = at;

  try {
    // A failed cleanup must not cost the alerts, which still report low disk.
    await prune(false, now).catch((error) => console.error(`[${at}] storage prune failed: ${String(error)}`));

    const { snapshot, memcapLogOffset, guardLogOffset } = await collectSnapshot(
      state.memcapLogOffset,
      state.guardLogOffset,
    );
    await writeJson(paths.lastSnapshot, snapshot);

    const observed = thresholdAlerts({
      pressureLevel: snapshot.memory.pressureLevel,
      swapUsedGib: snapshot.memory.swapUsedGib,
      diskFreeGib: snapshot.diskFreeGib,
      largestTemp: snapshot.largestTemp,
      loadAverage15: snapshot.cpu.loadAverage[2],
      cores: snapshot.cpu.cores,
      orphans: snapshot.orphans,
      sustainedCpu: snapshot.cpu.sustained,
      guardStops: snapshot.cpu.guardStops,
      memcapHealthy: memcapHealthy(snapshot),
      sharedPorts: snapshot.sharedPorts,
    });
    const merged = mergeAlerts(readAlerts(paths), observed, at);
    await writeJson(paths.alerts, pruneAlerts(merged.alerts, now));
    for (const alert of merged.opened) {
      if (alert.severity !== "info") await notify(alert);
    }
    console.log(
      `[${at}] alerts: ${observed.map((alert) => alert.key).join(", ") || "none"} opened=${merged.opened.length} resolved=${merged.resolved.length}`,
    );

    state.memcapLogOffset = memcapLogOffset;
    state.guardLogOffset = guardLogOffset;
    state.runs = [...state.runs, { at, alerts: observed.map((alert) => alert.key) }].slice(-MAC_WATCHER.historyLimit);
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

/** On-demand Codex diagnosis of a fresh snapshot; prints its findings and leaves alerts and offsets untouched. */
async function review(): Promise<void> {
  const state = readState(paths);
  const { snapshot } = await collectSnapshot(state.memcapLogOffset, state.guardLogOffset);
  const open = readAlerts(paths).filter((alert) => alert.status === "open");
  const result = await reviewWithCodex(snapshot, open);

  console.log(result.runNote);
  for (const alert of result.alerts) {
    console.log(`\n[${alert.severity}] ${alert.title}\n  evidence: ${alert.evidence}\n  fix: ${alert.fix}`);
  }
}

async function prune(dryRun: boolean, now = new Date()): Promise<void> {
  const report = await pruneStorage({ home: HOME, now, dryRun });
  if (!dryRun) await writeJson(paths.storagePrune, report);

  console.log(`[${report.at}] storage: ${summarizePrune(report)}`);
  if (!dryRun) return;
  for (const entry of [...report.deleted, ...report.worktreesRemoved]) {
    console.log(`  remove ${(entry.bytes / 1024 ** 3).toFixed(2)}G ${shortCommand(entry.path)}`);
  }
  for (const database of report.testDatabasesDropped) {
    console.log(`  drop test database ${database.name} (${(database.bytes / 1024 ** 2).toFixed(0)}M)`);
  }
  for (const kept of report.worktreesKept) {
    console.log(`  keep worktree ${shortCommand(kept.path)} (${kept.reason}, idle ${kept.idleDays}d)`);
  }
  for (const error of report.errors) console.log(`  error ${error}`);
}

function readGuardState(): GuardState {
  try {
    return guardStateSchema.parse(JSON.parse(readFileSync(paths.guardState, "utf8")));
  } catch {
    return guardStateSchema.parse({});
  }
}

async function startedAt(pid: number): Promise<string | undefined> {
  const result = await execa("ps", ["-o", "lstart=", "-p", String(pid)], { reject: false });
  return result.exitCode === 0 ? result.stdout.trim().replace(/\s+/g, " ") : undefined;
}

/** Stops leftover agent tooling that stayed hot; rechecks identity before each signal so a reused pid is never hit. */
async function guardOnce(): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const now = Date.now();
  const { next, stop } = stepGuard(readGuardState(), await listProcesses(), uid, now);

  for (const { row, percent, hotMinutes } of stop) {
    if ((await startedAt(row.pid)) !== row.started) continue;
    process.kill(row.pid, "SIGTERM");
    await Bun.sleep(5_000);
    if ((await startedAt(row.pid)) === row.started) process.kill(row.pid, "SIGKILL");
    delete next.tracked[String(row.pid)];
    await appendFile(
      paths.guardLog,
      `[${new Date(now).toISOString()}] stopped pid ${row.pid} -- leftover at ${percent}% CPU for ${hotMinutes} min, ${row.rssMib} MiB: ${shortCommand(row.command)}\n`,
    );
  }

  await writeJson(paths.guardState, next);
}

function printStatus(): void {
  const state = readState(paths);
  const alerts = readAlerts(paths);
  const open = alerts.filter((alert) => alert.status === "open");
  console.log(`Last run: ${state.lastRunAt ?? "never"}`);
  console.log(`Last success: ${state.lastSuccessAt ?? "never"}`);
  if (state.lastError) console.log(`Last error: ${state.lastError}`);
  console.log(`\nOpen alerts (${open.length}):`);
  for (const alert of open) {
    console.log(`- [${alert.severity}] ${alert.key}: ${alert.title}\n  evidence: ${alert.evidence}\n  fix: ${alert.fix}`);
  }
  console.log("\nRecent runs:");
  for (const entry of state.runs.slice(-10)) console.log(`- ${entry.at}: ${entry.alerts.join(", ") || "no alerts"}`);
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
    await runOnce();
    break;
  case "review":
    await review();
    break;
  case "prune":
    await prune(args.includes("--dry-run"));
    break;
  case "guard":
    await guardOnce();
    break;
  case "status":
    printStatus();
    break;
  case "resolve":
    await resolveAlert(args[0]);
    break;
  default:
    console.error("usage: mac-watcher run | review | prune [--dry-run] | guard | status | resolve <alert-key>");
    process.exitCode = 2;
}
