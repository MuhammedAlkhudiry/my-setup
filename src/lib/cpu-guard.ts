import { execa } from "execa";
import { z } from "zod";

import { MAC_WATCHER } from "../../config/mac-watcher";

export interface ProcessRow {
  pid: number;
  ppid: number;
  uid: number;
  rssMib: number;
  /** Instant CPU from ps, decayed over recent seconds; 100 is one full core. */
  cpuPercent: number;
  cpuSeconds: number;
  ageSeconds: number;
  /** Start time as ps prints it; pid plus start identifies a process across samples. */
  started: string;
  command: string;
}

/** Parses ps `etime` (`[[dd-]hh:]mm:ss`) into seconds. */
export function parseEtime(value: string): number {
  const [days, rest] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts;
  return Number(days) * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/** Parses ps `time` (`[[dd-]hh:]mm:ss.cc`) into seconds. */
export function parseCpuTime(value: string): number {
  return parseEtime(value.split(".")[0]) + Number(`0.${value.split(".")[1] ?? "0"}`);
}

const PS_FORMAT = "pid=,ppid=,uid=,rss=,%cpu=,time=,etime=,lstart=,command=";
const PS_LINE =
  /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function parsePsOutput(output: string): ProcessRow[] {
  return output
    .split("\n")
    .map((line) => line.trim().match(PS_LINE))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      rssMib: Math.round(Number(match[4]) / 1024),
      cpuPercent: Number(match[5]),
      cpuSeconds: parseCpuTime(match[6]),
      ageSeconds: parseEtime(match[7]),
      started: match[8].replace(/\s+/g, " "),
      command: match[9],
    }));
}

export async function listProcesses(): Promise<ProcessRow[]> {
  const result = await execa("ps", ["-axo", PS_FORMAT], { reject: false, timeout: 20_000 });
  return parsePsOutput(result.stdout);
}

/**
 * Agent tooling that commonly outlives its session: browsers for automation, MCP servers, dev servers, and Laravel's
 * long-running workers and servers.
 */
export const AGENT_TOOLING_PATTERN =
  /Chrome for Testing|ms-playwright|chrome-headless-shell|chrome-devtools-mcp|playwright|\bmcp\b|-mcp|vite|next dev|webpack|esbuild|nodemon|\btsx\b|expo start|metro|artisan (horizon|queue:(work|listen)|serve|reverb:start|octane:start|schedule:work)/i;

/** Main app executables, system binaries, agent CLIs, and devices are never guard targets. */
const PROTECTED_COMMAND =
  /^\/(System|usr\/libexec|usr\/sbin|sbin)\/|\.app\/Contents\/MacOS\/[^/ ]+( |$)|(^|\/)(claude|codex|opencode)( |$)|qemu-system|CoreSimulator|launchd_sim/;

/** A leftover agent-tooling process: its parent exited, it belongs to this user, and it is not protected. */
export function isOrphanedAgentTooling(row: ProcessRow, uid: number): boolean {
  return (
    row.ppid === 1 &&
    row.uid === uid &&
    AGENT_TOOLING_PATTERN.test(row.command) &&
    !PROTECTED_COMMAND.test(row.command)
  );
}

/** Average CPU over a process's whole life, in percent of one core. */
export function lifetimeCpuPercent(row: ProcessRow): number {
  return row.ageSeconds > 0 ? (row.cpuSeconds / row.ageSeconds) * 100 : 0;
}

/** Processes that have kept at least `percent` CPU across at least `minMinutes`; reported, never stopped. */
export function sustainedCpuProcesses(
  rows: ProcessRow[],
  percent: number = MAC_WATCHER.cpu.sustainedPercent,
  minMinutes: number = MAC_WATCHER.cpu.sustainedMinMinutes,
): ProcessRow[] {
  return rows
    .filter((row) => row.ageSeconds >= minMinutes * 60 && lifetimeCpuPercent(row) >= percent)
    .sort((a, b) => lifetimeCpuPercent(b) - lifetimeCpuPercent(a));
}

// =============================================================================
// Guard state: one sample per tracked leftover, compared across guard passes
// =============================================================================

const trackedSchema = z.object({
  started: z.string(),
  cpuSeconds: z.number(),
  sampledAt: z.number(),
  hotSince: z.number().optional(),
});

export const guardStateSchema = z.object({
  tracked: z.record(z.string(), trackedSchema).default({}),
});
export type GuardState = z.infer<typeof guardStateSchema>;

export interface GuardStep {
  next: GuardState;
  /** Leftovers that stayed hot long enough to stop, with their average CPU since they turned hot. */
  stop: Array<{ row: ProcessRow; percent: number; hotMinutes: number }>;
}

/**
 * Compares this pass with the last one. A leftover is hot when it used at least `hotPercent` of a core between the two
 * samples; it is stopped once it has stayed hot for `stopAfterMinutes`. A cool sample or a reused pid resets it.
 */
export function stepGuard(
  previous: GuardState,
  rows: ProcessRow[],
  uid: number,
  now: number,
  options: { hotPercent: number; stopAfterMinutes: number } = MAC_WATCHER.cpu.guard,
): GuardStep {
  const next: GuardState = { tracked: {} };
  const stop: GuardStep["stop"] = [];

  for (const row of rows.filter((candidate) => isOrphanedAgentTooling(candidate, uid))) {
    const before = previous.tracked[String(row.pid)];
    const same = before && before.started === row.started;
    const wallSeconds = same ? (now - before.sampledAt) / 1000 : 0;
    const percent = wallSeconds > 0 ? ((row.cpuSeconds - before!.cpuSeconds) / wallSeconds) * 100 : 0;
    const hot = wallSeconds > 0 && percent >= options.hotPercent;
    const hotSince = hot ? (before?.hotSince ?? before!.sampledAt) : undefined;

    next.tracked[String(row.pid)] = { started: row.started, cpuSeconds: row.cpuSeconds, sampledAt: now, hotSince };
    if (hotSince !== undefined && now - hotSince >= options.stopAfterMinutes * 60_000) {
      stop.push({ row, percent: Math.round(percent), hotMinutes: Math.round((now - hotSince) / 60_000) });
    }
  }
  return { next, stop };
}
