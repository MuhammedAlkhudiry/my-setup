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
  patterns: z.array(z.string()),
  alerts: z.array(observedAlertSchema),
});
export type Review = z.infer<typeof reviewSchema>;

/** JSON Schema handed to `codex exec --output-schema`; strict mode needs every key required and no extras. */
export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["runNote", "patterns", "alerts"],
  properties: {
    runNote: { type: "string" },
    patterns: { type: "array", items: { type: "string" } },
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
  reviewed: z.boolean(),
  reasons: z.array(z.string()),
  note: z.string(),
});
export type WatcherRun = z.infer<typeof runSchema>;

const stateSchema = z.object({
  lastRunAt: z.string().optional(),
  lastReviewAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lastError: z.string().optional(),
  memcapLogOffset: z.number().default(0),
  seenOrphanPids: z.array(z.number()).default([]),
  guardLogOffset: z.number().default(0),
  seenCpuPids: z.array(z.number()).default([]),
  patterns: z.array(z.string()).default([]),
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
// Review gate and alert lifecycle
// =============================================================================

export interface GateInput {
  freePercent: number | undefined;
  pressureLevel: "normal" | "warning" | "critical" | "unknown";
  swapUsedGib: number;
  diskFreeGib: number;
  newOrphanCount: number;
  loadAverage15: number;
  cores: number;
  newSustainedCpuCount: number;
  guardStops: number;
  memcapActionLines: number;
  memcapHealthy: boolean;
  hoursSinceReview: number | undefined;
}

/**
 * Returns why this run deserves a Codex review; an empty list means a quiet run that costs no AI usage. Known orphans and
 * open alerts wait for the daily refresh so the same issue does not buy a review on every run.
 */
export function reviewReasons(input: GateInput): string[] {
  const gate = { ...MAC_WATCHER.gate, maxLoadPerCore: MAC_WATCHER.cpu.maxLoadPerCore };
  const reasons: string[] = [];
  if (input.pressureLevel === "warning" || input.pressureLevel === "critical") {
    reasons.push(`memory pressure ${input.pressureLevel}`);
  }
  if (input.freePercent !== undefined && input.freePercent < gate.minFreePercent) {
    reasons.push(`memory free ${input.freePercent}%`);
  }
  if (input.swapUsedGib > gate.maxSwapUsedGib) reasons.push(`swap ${input.swapUsedGib.toFixed(1)} GiB`);
  if (input.diskFreeGib < gate.minDiskFreeGib) reasons.push(`disk free ${input.diskFreeGib.toFixed(0)} GiB`);
  if (input.loadAverage15 > input.cores * gate.maxLoadPerCore) {
    reasons.push(`load ${input.loadAverage15.toFixed(1)} on ${input.cores} cores`);
  }
  if (input.newSustainedCpuCount > 0) reasons.push(`${input.newSustainedCpuCount} new sustained CPU users`);
  if (input.guardStops > 0) reasons.push(`${input.guardStops} CPU guard stops since last run`);
  if (input.newOrphanCount > 0) reasons.push(`${input.newOrphanCount} new orphaned agent processes`);
  if (input.memcapActionLines > 0) reasons.push(`${input.memcapActionLines} memcap actions since last run`);
  if (!input.memcapHealthy) reasons.push("memcap not healthy");
  if (input.hoursSinceReview === undefined || input.hoursSinceReview >= gate.maxHoursWithoutReview) {
    reasons.push("daily memory refresh");
  }
  return reasons;
}

/**
 * Applies one Codex review to the stored alerts. Observed issues open or reopen their alert; open alerts the review no
 * longer reports close after enough consecutive clear reviews.
 */
export function mergeAlerts(
  existing: Alert[],
  observed: ObservedAlert[],
  now: string,
  autoResolveAfter: number = MAC_WATCHER.autoResolveAfterClearReviews,
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
