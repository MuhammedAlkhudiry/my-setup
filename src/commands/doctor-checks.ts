#!/usr/bin/env bun

/**
 * Local hygiene checks used by `doctor`. Prints one `<level>\t<label>: <detail>` line per finding.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execaSync } from "execa";

import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { CLAUDE_POOL } from "../../config/claude-pool";
import { mergeRtkHooks } from "../../config/rtk";
import { claudePoolPaths, findLegacyClaudeFiles } from "../lib/claude-pool";
import { renderBaseRules } from "./install";

const ROOT_DIR = join(import.meta.dir, "..", "..");
const HOME = process.env.HOME || "";
const MIN_FREE_GIB = 20;

const INSTALLED_RULES_FILES = [
  { label: "Claude Code", path: claudePoolPaths(HOME).claudeRules },
  { label: "Codex", path: join(HOME, ".codex/AGENTS.md") },
  { label: "OpenCode", path: join(HOME, ".config/opencode/AGENTS.md") },
];

interface Finding {
  level: "required" | "optional";
  label: string;
  detail: string;
}

const findings: Finding[] = [];

const zshCustom = readFileSync(join(ROOT_DIR, "shell", "zsh-custom.zsh"), "utf-8");
if (/^\s*(alias\s+zsh=|zsh\s*\(\)|function\s+zsh\b)/m.test(zshCustom)) {
  findings.push({
    level: "required",
    label: "zsh shadowed",
    detail: "shell/zsh-custom.zsh redefines zsh; scripts run as `zsh file.zsh` silently do nothing",
  });
}

for (const root of [ROOT_DIR, ...ACTIVE_PROJECTS.map((project) => project.canonicalRoot)]) {
  if (!existsSync(join(root, ".git"))) continue;
  const result = execaSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    reject: false,
  });
  if (result.exitCode !== 0) continue;
  const prunable = result.stdout
    .split(/\n\n+/)
    .filter((block) => /^prunable/m.test(block))
    .map((block) => block.match(/^worktree (.+)$/m)?.[1])
    .filter((path): path is string => Boolean(path));
  if (prunable.length > 0) {
    findings.push({
      level: "optional",
      label: "prunable worktrees",
      detail: `${root}: ${prunable.join(", ")}; run git worktree prune`,
    });
  }
}

const expectedRules = renderBaseRules(
  readFileSync(join(ROOT_DIR, "content", "base-rules.md"), "utf-8"),
);
const staleRules = INSTALLED_RULES_FILES.filter(
  ({ path }) => !existsSync(path) || readFileSync(path, "utf-8") !== expectedRules,
);
if (staleRules.length > 0) {
  findings.push({
    level: "required",
    label: "stale installed rules",
    detail: `${staleRules
      .map(({ label }) => label)
      .join(", ")} differ from content/base-rules.md; run mise run install -- --compact`,
  });
}

for (const [agent, path] of [
  ["claude", claudePoolPaths(HOME).claudeSettings],
  ["codex", join(HOME, ".codex/hooks.json")],
] as const) {
  try {
    const config = JSON.parse(readFileSync(path, "utf-8"));
    if (
      config.disableAllHooks === true ||
      !isDeepStrictEqual(config.hooks, mergeRtkHooks(config.hooks, agent))
    ) {
      throw new Error("missing, disabled, duplicated, or stale hook");
    }
  } catch {
    findings.push({
      level: "required",
      label: `RTK ${agent} hook`,
      detail: `${path} needs an enabled RTK hook; run mise run install -- --compact`,
    });
  }
}

const rtkPlugin = join(HOME, ".config/opencode/plugins/rtk.ts");
if (
  !existsSync(rtkPlugin) ||
  !readFileSync(rtkPlugin, "utf-8").includes("rtk rewrite ${command}")
) {
  findings.push({
    level: "required",
    label: "RTK OpenCode plugin",
    detail: `${rtkPlugin} is missing or invalid; run mise run install -- --compact`,
  });
}

if (
  Bun.which("rtk") &&
  execaSync("rtk", ["hook", "codex", "--help"], { reject: false }).exitCode !== 0
) {
  findings.push({
    level: "required",
    label: "RTK version",
    detail: "native Codex hooks require RTK 0.50.0 or newer; run brew upgrade rtk",
  });
}

const pool = claudePoolPaths(HOME);
const poolFiles = [
  pool.config,
  pool.clientKey,
  pool.managementKey,
  pool.claudeSettings,
  pool.launchAgent,
  pool.stdoutLog,
  pool.stderrLog,
];
for (const path of poolFiles) {
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) {
    findings.push({ level: "optional", label: "Claude pool file", detail: `${path} is missing` });
  } else if (!file.isFile() || (file.mode & 0o777) !== 0o600) {
    findings.push({ level: "required", label: "Claude pool permissions", detail: `${path} must be a private mode-600 file` });
  }
}
for (const path of [join(HOME, ".cli-proxy-api"), pool.authDir, pool.claudeDir]) {
  const dir = lstatSync(path, { throwIfNoEntry: false });
  if (!dir || !dir.isDirectory() || (dir.mode & 0o777) !== 0o700) {
    findings.push({ level: "required", label: "Claude pool permissions", detail: `${path} must be a private mode-700 directory` });
  }
}

if (existsSync(pool.config)) {
  const config = readFileSync(pool.config, "utf8");
  if (
    !config.includes('host: "127.0.0.1"') ||
    !config.includes(`port: ${CLAUDE_POOL.port}`) ||
    !config.includes("allow-remote: false") ||
    !config.includes("disable-control-panel: false") ||
    !config.includes("session-affinity-subagents: false") ||
    !config.includes('alias: "claude-haiku-4-5"') ||
    !config.includes('alias: "claude-opus-4-5"')
  ) {
    findings.push({
      level: "required",
      label: "Claude pool configuration",
      detail: "local routing, dashboard, or model aliases differ from the managed setup; run mise run install -- --compact",
    });
  }
}

if (existsSync(pool.claudeSettings) && existsSync(pool.clientKey)) {
  try {
    const settings = JSON.parse(readFileSync(pool.claudeSettings, "utf8"));
    const clientKey = readFileSync(pool.clientKey, "utf8").trim();
    if (
      settings.env?.ANTHROPIC_BASE_URL !== `http://127.0.0.1:${CLAUDE_POOL.port}` ||
      settings.env?.ANTHROPIC_AUTH_TOKEN !== clientKey ||
      settings.env?.ANTHROPIC_API_KEY !== ""
    ) {
      throw new Error("Claude settings do not match the local proxy");
    }
  } catch {
    findings.push({
      level: "required",
      label: "Claude pool credentials",
      detail: "isolated Claude settings do not match the local client key; run mise run install -- --compact",
    });
  }
}

const legacyClaudeFiles = findLegacyClaudeFiles(HOME);
if (legacyClaudeFiles.length > 0) {
  findings.push({
    level: "required",
    label: "old Claude config",
    detail: `${legacyClaudeFiles.join(", ")} would load stale rules in Claude Pool sessions; run mise run install -- --compact`,
  });
}

const poolService = execaSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${CLAUDE_POOL.label}`], {
  reject: false,
});
if (poolService.exitCode !== 0 || !poolService.stdout.includes("state = running")) {
  findings.push({
    level: "optional",
    label: "Claude pool service",
    detail: "launch agent is not running; run mise run install -- --compact",
  });
}
const poolListener = execaSync("lsof", ["-nP", `-iTCP:${CLAUDE_POOL.port}`, "-sTCP:LISTEN"], {
  reject: false,
});
const listenerLines = poolListener.stdout.split("\n").slice(1).filter(Boolean);
if (
  listenerLines.length === 0 ||
  listenerLines.some((line) => !line.includes(`127.0.0.1:${CLAUDE_POOL.port}`))
) {
  findings.push({
    level: "required",
    label: "Claude pool listener",
    detail: `port ${CLAUDE_POOL.port} must listen only on 127.0.0.1`,
  });
}

if (existsSync(pool.authDir)) {
  const accounts = readdirSync(pool.authDir).filter((name) => /^claude-.+\.json$/.test(name)).length;
  if (accounts < 2) {
    findings.push({
      level: "optional",
      label: "Claude pool accounts",
      detail: `found ${accounts} Claude OAuth credential files; authenticate the other account locally`,
    });
  }
}

const t3SettingsPath = join(HOME, ".t3/userdata/settings.json");
if (existsSync(t3SettingsPath)) {
  try {
    const t3Settings = JSON.parse(readFileSync(t3SettingsPath, "utf8"));
    const instance = t3Settings.providerInstances?.[CLAUDE_POOL.t3InstanceId];
    const defaultClaude = t3Settings.providerInstances?.claudeAgent;
    if (defaultClaude && defaultClaude.enabled !== false) {
      findings.push({
        level: "optional",
        label: "T3 default Claude",
        detail: "disable the default Claude provider in T3 Code Settings > Providers; Claude runs only through Claude Pool",
      });
    }
    if (
      instance?.driver !== "claudeAgent" ||
      instance.enabled === false ||
      !["~/.claude_cliproxy", pool.claudeDir].includes(instance.config?.homePath)
    ) {
      throw new Error("Claude Pool provider instance is missing or disabled");
    }
  } catch {
    findings.push({
      level: "optional",
      label: "T3 Claude Pool",
      detail: "add the Claude Pool instance in T3 Code Settings > Providers with CLAUDE_CONFIG_DIR ~/.claude_cliproxy",
    });
  }
} else {
  findings.push({
    level: "optional",
    label: "T3 Claude Pool",
    detail: "T3 Code settings are missing; add the Claude Pool instance after installing T3 Code",
  });
}

const disk = statfsSync(HOME);
const freeGib = (disk.bavail * disk.bsize) / 1024 ** 3;
if (freeGib < MIN_FREE_GIB) {
  findings.push({
    level: "optional",
    label: "low disk space",
    detail: `${freeGib.toFixed(1)} GiB free, below ${MIN_FREE_GIB} GiB; clear build caches or run mo clean`,
  });
}

const avdHome = join(HOME, ".android/avd");
if (
  existsSync(join(HOME, ".android")) &&
  lstatSync(avdHome, { throwIfNoEntry: false })?.isSymbolicLink()
) {
  if (!existsSync(avdHome)) {
    findings.push({
      level: "optional",
      label: "Android emulators offline",
      detail: `${avdHome} points to ${readlinkSync(avdHome)}, which is not mounted; connect the SSD`,
    });
  }
}

if (findings.length === 0) {
  console.log("no local hygiene findings");
  process.exit(0);
}

for (const finding of findings)
  console.log(`${finding.level}\t${finding.label}: ${finding.detail}`);
process.exit(findings.some((finding) => finding.level === "required") ? 1 : 2);
