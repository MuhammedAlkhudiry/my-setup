import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { execa } from "execa";
import { z } from "zod";

import { MAC_WATCHER, MEMCAP_CONFIG, MEMCAP_LAUNCH_AGENT_LABEL } from "../../config/mac-watcher";

export function macWatcherPaths(home: string) {
  const stateDir = join(home, ".local/state/mac-watcher");
  const memcapStateDir = join(home, ".local/state/memcap");
  return {
    stateDir,
    state: join(stateDir, "state.json"),
    alerts: join(stateDir, "alerts.json"),
    lastSnapshot: join(stateDir, "last-snapshot.json"),
    outputSchema: join(stateDir, "codex-output-schema.json"),
    codexOutput: join(stateDir, "codex-last-output.json"),
    guardState: join(stateDir, "guard.json"),
    guardLog: join(stateDir, "guard.log"),
    storagePrune: join(stateDir, "storage-prune.json"),
    launchAgent: join(home, "Library/LaunchAgents", `${MAC_WATCHER.label}.plist`),
    guardLaunchAgent: join(home, "Library/LaunchAgents", `${MAC_WATCHER.guardLabel}.plist`),
    log: join(home, "Library/Logs/mac-watcher.log"),
    memcapConfig: join(home, ".config/memcap/memcap.conf"),
    memcapStateDir,
    memcapActionsLog: join(memcapStateDir, "actions.log"),
    memcapLastPass: join(memcapStateDir, "last-pass"),
    memcapPaused: join(memcapStateDir, "paused"),
  };
}

export type MacWatcherPaths = ReturnType<typeof macWatcherPaths>;

// =============================================================================
// Stored state
// =============================================================================

const severitySchema = z.enum(["info", "warning", "critical"]);

export const observedAlertSchema = z.object({
  key: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  severity: severitySchema,
  title: z.string(),
  evidence: z.string(),
  fix: z.string(),
});
export type ObservedAlert = z.infer<typeof observedAlertSchema>;

export const reviewSchema = z.object({
  runNote: z.string(),
  alerts: z.array(observedAlertSchema),
});
export type Review = z.infer<typeof reviewSchema>;

/** JSON Schema handed to `codex exec --output-schema`; strict mode needs every key required and no extras. */
export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["runNote", "alerts"],
  properties: {
    runNote: { type: "string" },
    alerts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "severity", "title", "evidence", "fix"],
        properties: {
          key: { type: "string" },
          severity: { type: "string", enum: ["info", "warning", "critical"] },
          title: { type: "string" },
          evidence: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
  },
} as const;

const alertSchema = observedAlertSchema.extend({
  status: z.enum(["open", "resolved"]),
  firstSeen: z.string(),
  lastSeen: z.string(),
  seenCount: z.number(),
  clearReviews: z.number(),
  resolvedAt: z.string().optional(),
  resolvedBy: z.enum(["auto", "manual"]).optional(),
});
export type Alert = z.infer<typeof alertSchema>;

const runSchema = z.object({
  at: z.string(),
  /** Keys of the alerts this run observed. */
  alerts: z.array(z.string()).default([]),
});
export type WatcherRun = z.infer<typeof runSchema>;

const stateSchema = z.object({
  lastRunAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lastError: z.string().optional(),
  memcapLogOffset: z.number().default(0),
  guardLogOffset: z.number().default(0),
  runs: z.array(runSchema).default([]),
});
export type WatcherState = z.infer<typeof stateSchema>;

function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid watcher file ${path}: ${parsed.error.message}`);
  return parsed.data;
}

export function readState(paths: MacWatcherPaths): WatcherState {
  return readJson(paths.state, stateSchema, stateSchema.parse({}));
}

export function readAlerts(paths: MacWatcherPaths): Alert[] {
  return readJson(paths.alerts, z.array(alertSchema), []);
}

/** Writes through a temporary file so a crash mid-run never leaves half a JSON file behind. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}

// =============================================================================
// Threshold alerts and alert lifecycle
// =============================================================================

export interface ProcessSummary {
  command: string;
  ageMinutes: number;
  cpuLifetime?: number;
}

export interface AlertInput {
  pressureLevel: "normal" | "warning" | "critical" | "unknown";
  swapUsedGib: number;
  diskFreeGib: number;
  largestTemp: Array<{ path: string; gib: number }>;
  loadAverage15: number;
  cores: number;
  orphans: ProcessSummary[];
  sustainedCpu: ProcessSummary[];
  guardStops: string[];
  memcapHealthy: boolean;
}

function topCommands(rows: ProcessSummary[]): string {
  return rows
    .slice(0, 3)
    .map((row) => `${row.command.slice(0, 80)} (${row.ageMinutes} min${row.cpuLifetime ? `, ${row.cpuLifetime}% CPU` : ""})`)
    .join("; ");
}

/** Every alert this snapshot crosses a threshold for. Keys are stable so an issue stays one alert while it lasts. */
export function thresholdAlerts(input: AlertInput): ObservedAlert[] {
  const { thresholds } = MAC_WATCHER;
  const alerts: ObservedAlert[] = [];

  if (input.diskFreeGib < thresholds.minDiskFreeGib) {
    const temp = input.largestTemp.map((entry) => `${entry.path} ${entry.gib}G`).join(", ");
    alerts.push({
      key: "low-disk",
      severity: input.diskFreeGib < thresholds.criticalDiskFreeGib ? "critical" : "warning",
      title: `Disk free ${input.diskFreeGib.toFixed(0)} GiB`,
      evidence: temp ? `largest temp entries: ${temp}` : "below the free-space threshold",
      fix: "Run mise run watcher -- prune --dry-run to see what the cleanup rules free, then remove large temp entries or archive to the SSD.",
    });
  }
  if (input.pressureLevel === "warning" || input.pressureLevel === "critical") {
    alerts.push({
      key: "memory-pressure",
      severity: input.pressureLevel,
      title: `Memory pressure ${input.pressureLevel}`,
      evidence: "macOS reports memory pressure above normal",
      fix: "Shut down simulators, emulators, or browsers you are not using.",
    });
  }
  if (input.swapUsedGib > thresholds.maxSwapUsedGib) {
    alerts.push({
      key: "high-swap",
      severity: "warning",
      title: `Swap ${input.swapUsedGib.toFixed(1)} GiB`,
      evidence: `above ${thresholds.maxSwapUsedGib} GiB`,
      fix: "Run fewer simulators, emulators, and heavy builds at once; a restart clears stale swap.",
    });
  }
  if (input.loadAverage15 > input.cores * MAC_WATCHER.cpu.maxLoadPerCore) {
    alerts.push({
      key: "cpu-overload",
      severity: "warning",
      title: `Load ${input.loadAverage15.toFixed(1)} on ${input.cores} cores`,
      evidence: "15-minute load average above core count",
      fix: "Run fewer builds, QA runs, and agents in parallel.",
    });
  }
  if (input.orphans.length > 0) {
    alerts.push({
      key: "orphaned-agent-processes",
      severity: "warning",
      title: `${input.orphans.length} orphaned agent processes`,
      evidence: topCommands(input.orphans),
      fix: "Make the tool that launched them stop its children on exit; memcap reaps them meanwhile.",
    });
  }
  if (input.sustainedCpu.length > 0) {
    alerts.push({
      key: "sustained-cpu",
      severity: "warning",
      title: `${input.sustainedCpu.length} processes busy for a long time`,
      evidence: topCommands(input.sustainedCpu),
      fix: "Stop the device or tool if it is not doing work you need.",
    });
  }
  if (input.guardStops.length > 0) {
    alerts.push({
      key: "cpu-guard-stops",
      severity: "info",
      title: `CPU guard stopped ${input.guardStops.length} leftover processes`,
      evidence: input.guardStops.at(-1) ?? "",
      fix: "If the same tool keeps appearing, fix it so it exits with its parent.",
    });
  }
  if (!input.memcapHealthy) {
    alerts.push({
      key: "memcap-unhealthy",
      severity: "warning",
      title: "memcap is not running normally",
      evidence: "service not loaded, paused, or no recent pass",
      fix: "Run memcap status, then mise run install -- --compact.",
    });
  }

  return alerts;
}

/**
 * Applies one run's observed alerts to the stored ones. Observed issues open or reopen their alert; open alerts no longer
 * observed close after enough consecutive clear runs.
 */
export function mergeAlerts(
  existing: Alert[],
  observed: ObservedAlert[],
  now: string,
  autoResolveAfter: number = MAC_WATCHER.autoResolveAfterClearRuns,
): { alerts: Alert[]; opened: Alert[]; resolved: Alert[] } {
  const observedByKey = new Map(observed.map((alert) => [alert.key, alert]));
  const opened: Alert[] = [];
  const resolved: Alert[] = [];
  const alerts: Alert[] = existing.map((alert) => {
    const seen = observedByKey.get(alert.key);
    if (seen) {
      observedByKey.delete(alert.key);
      const next: Alert = {
        ...alert,
        ...seen,
        status: "open",
        lastSeen: now,
        seenCount: alert.seenCount + 1,
        clearReviews: 0,
        resolvedAt: undefined,
        resolvedBy: undefined,
      };
      if (alert.status === "resolved") opened.push(next);
      return next;
    }
    if (alert.status !== "open") return alert;
    const clearReviews = alert.clearReviews + 1;
    if (clearReviews < autoResolveAfter) return { ...alert, clearReviews };
    const next: Alert = { ...alert, clearReviews, status: "resolved", resolvedAt: now, resolvedBy: "auto" };
    resolved.push(next);
    return next;
  });
  for (const seen of observedByKey.values()) {
    const next: Alert = {
      ...seen,
      status: "open",
      firstSeen: now,
      lastSeen: now,
      seenCount: 1,
      clearReviews: 0,
    };
    alerts.push(next);
    opened.push(next);
  }
  return { alerts, opened, resolved };
}

/** Drops resolved alerts older than 30 days so the file stays small. */
export function pruneAlerts(alerts: Alert[], now: Date): Alert[] {
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return alerts.filter(
    (alert) => alert.status === "open" || !alert.resolvedAt || Date.parse(alert.resolvedAt) >= cutoff,
  );
}

// =============================================================================
// Installed files
// =============================================================================

export function renderMemcapConfig(config: Record<string, string | number> = MEMCAP_CONFIG): string {
  const lines = ["# Managed by my-setup. Do not edit by hand.", "# Source of truth: config/mac-watcher.ts"];
  for (const [key, value] of Object.entries(config)) {
    lines.push(`${key}=${typeof value === "number" ? value : JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** `run` is the scheduled review; `guard` is the minute-by-minute CPU guard. */
export function renderWatcherLaunchAgent(options: {
  mode: "run" | "guard";
  paths: MacWatcherPaths;
  bun: string;
  script: string;
  home: string;
}): string {
  const { mode, paths, bun, script, home } = options;
  const path = [
    join(home, ".local/bin"),
    join(home, ".bun/bin"),
    "/opt/homebrew/bin",
    join(home, "Library/Android/sdk/platform-tools"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const timing =
    mode === "run"
      ? [
          "  <key>StartCalendarInterval</key><array>",
          ...MAC_WATCHER.schedule.map(
            ({ hour, minute }) =>
              `    <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`,
          ),
          "  </array>",
        ]
      : [
          `  <key>StartInterval</key><integer>${MAC_WATCHER.cpu.guard.intervalSeconds}</integer>`,
          "  <key>RunAtLoad</key><true/>",
        ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${mode === "run" ? MAC_WATCHER.label : MAC_WATCHER.guardLabel}</string>`,
    "  <key>ProgramArguments</key><array>",
    `    <string>${xmlEscape(bun)}</string>`,
    `    <string>${xmlEscape(script)}</string>`,
    `    <string>${mode}</string>`,
    "  </array>",
    "  <key>EnvironmentVariables</key><dict>",
    `    <key>HOME</key><string>${xmlEscape(home)}</string>`,
    `    <key>PATH</key><string>${xmlEscape(path)}</string>`,
    "  </dict>",
    ...timing,
    "  <key>ProcessType</key><string>Background</string>",
    "  <key>LowPriorityIO</key><true/>",
    `  <key>StandardOutPath</key><string>${xmlEscape(paths.log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(paths.log)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path) && (await readFile(path, "utf8")) === content) return false;
  await writeFile(path, content);
  return true;
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The Mac watcher requires macOS");
  return `gui/${uid}`;
}

export async function isLaunchAgentLoaded(label: string): Promise<boolean> {
  const result = await execa("launchctl", ["print", `${launchdDomain()}/${label}`], { reject: false });
  return result.exitCode === 0;
}

/**
 * memcap logs routine declines, grace holds, budget notes, and host warnings every pass; only kills, shutdowns, and
 * refusals are worth a review. The watcher measures disk and swap itself.
 */
const ROUTINE_MEMCAP_LINE =
  /watch: alive|watch: combined|declining|reclaimed nothing|holding it to|^\[[^\]]+\] (measure|notify|pressure):/;

export function isMemcapActionLine(line: string): boolean {
  return !ROUTINE_MEMCAP_LINE.test(line);
}

export type MacWatcherInstallResult = { memcapInstalled: boolean };

async function installLaunchAgent(label: string, path: string, plist: string): Promise<void> {
  const plistChanged = await writeIfChanged(path, plist);
  const loaded = await isLaunchAgentLoaded(label);
  if (loaded && plistChanged) {
    await execa("launchctl", ["bootout", `${launchdDomain()}/${label}`], { reject: false });
  }
  if (!loaded || plistChanged) {
    await execa("launchctl", ["bootstrap", launchdDomain(), path]);
  }
}

/** Installs memcap's managed config and background job, plus the watcher and CPU guard LaunchAgents. */
export async function installMacWatcher(options: {
  home: string;
  rootDir: string;
  bun: string;
}): Promise<MacWatcherInstallResult> {
  const { home, rootDir, bun } = options;
  const paths = macWatcherPaths(home);
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(dirname(paths.log), { recursive: true });
  await writeIfChanged(paths.memcapConfig, renderMemcapConfig());

  const memcapInstalled = Boolean(Bun.which("memcap"));
  if (memcapInstalled && !(await isLaunchAgentLoaded(MEMCAP_LAUNCH_AGENT_LABEL))) {
    await execa("memcap", ["service", "install"]);
  }

  const script = join(rootDir, "src/commands/mac-watcher.ts");
  await installLaunchAgent(
    MAC_WATCHER.label,
    paths.launchAgent,
    renderWatcherLaunchAgent({ mode: "run", paths, bun, script, home }),
  );
  await installLaunchAgent(
    MAC_WATCHER.guardLabel,
    paths.guardLaunchAgent,
    renderWatcherLaunchAgent({ mode: "guard", paths, bun, script, home }),
  );
  return { memcapInstalled };
}

export function fileAgeSeconds(path: string, now = Date.now()): number | undefined {
  const file = statSync(path, { throwIfNoEntry: false });
  return file ? (now - file.mtimeMs) / 1000 : undefined;
}
