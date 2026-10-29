#!/usr/bin/env bun

/**
 * Internal local installer used by `mise run install`.
 */

import { agentOutput } from "../lib/agent-output";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import {
  readFile,
  writeFile,
  copyFile,
  chmod,
  mkdir,
  rm,
  mkdtemp,
  symlink,
  readdir,
  lstat,
  unlink,
} from "fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "path";
import { homedir, tmpdir } from "os";
import { execa } from "execa";
import {
  OPTIONAL_EXTERNAL_SKILL_NAMES,
  REMOTE_SKILL_SOURCES,
  type RemoteSkill,
  type RemoteSkillSource,
} from "../../config/skills";
import { ACTIVE_PROJECTS, type ActiveProject } from "../../config/active-projects";
import type { DeviceProfile } from "../../config/devices";
import { createClaudeManagedSettings } from "../../config/claude";
import { CODEX_RETIRED_TOP_LEVEL_KEYS } from "../../config/codex";
import { CREDENTIALS_HOME_ENV, CREDENTIALS_ROOT } from "../../config/credentials";
import { MCP_SERVERS, RETIRED_MCP_SERVERS } from "../../config/mcp";
import { createOpencodeCliConfig, mergeOpencodeConfig } from "../../config/opencode";
import { mergeClaudeHooks, removeRetiredHooks } from "../../config/hooks";
import { renderCodexRules } from "../../config/permissions";
import {
  codexManagedSectionValues,
  codexManagedTopLevelValues,
  CODEX_REMOTE_POOL_TOP_LEVEL_KEYS,
  codexRemotePoolValues,
  renderCodexMcpServersToml,
} from "../lib/codex-config";
import { replaceDirectory, ensureParentDir } from "../lib/fs";
import { claudePoolPaths, installClaudePool, retireLegacyClaudeFiles } from "../lib/claude-pool";
import { secureManagedCredentials } from "../lib/credentials";
import {
  readDeviceProfile,
  readRemoteClaudePoolUrl,
  selectRemoteSkillSources,
} from "../lib/device";
import { installMergeQueue, uninstallMergeQueue } from "../lib/merge-queue-install";
import { installMacWatcher } from "../lib/mac-watcher";
import { installRaycastProvider, raycastProvidersPath } from "../lib/raycast";
import { print } from "../lib/print";
import { assertCentralizedModels, renderManagedMarkdown } from "../lib/models";
import { getRemoteSkillRefreshDecision, recordRemoteSkillRefresh } from "../lib/remote-skills";
import { discoverLocalSkills, findUnknownSkillReferences } from "../lib/skills";
import { disableSpotlightIndexing } from "../lib/spotlight";
import { installT3Settings, t3StateDir } from "../lib/t3-settings";
import { validateRemoteSkillSources } from "../lib/validation";
import { installVscodeKeymap, vscodeKeybindingsPath } from "../lib/vscode";

// =============================================================================
// Constants
// =============================================================================

const HOME = homedir();
const ROOT_DIR = join(import.meta.dir, "..", "..");
const STATE_HOME = process.env.XDG_STATE_HOME || join(HOME, ".local/state");

// =============================================================================
// Destination Paths
// =============================================================================

const OPENCODE_PATHS = {
  rules: join(HOME, ".config/opencode/AGENTS.md"),
  config: join(HOME, ".config/opencode/opencode.json"),
  cli: join(HOME, ".config/opencode/cli.json"),
};

const CODEX_PATHS = {
  rules: join(HOME, ".codex/AGENTS.md"),
  config: join(HOME, ".codex/config.toml"),
  execRules: join(HOME, ".codex/rules/default.rules"),
  hooks: join(HOME, ".codex/hooks.json"),
};

// With the Claude Pool, Claude Code's config dir is the pool's CLAUDE_CONFIG_DIR; direct sign-in uses the default.
export function claudePaths(profile: DeviceProfile) {
  if (profile.claude === "pool") {
    const pool = claudePoolPaths(HOME);
    return {
      configDir: pool.claudeDir,
      rules: pool.claudeRules,
      skills: pool.claudeSkills,
      settings: pool.claudeSettings,
    };
  }

  const configDir = join(HOME, ".claude");
  return {
    configDir,
    rules: join(configDir, "CLAUDE.md"),
    skills: join(configDir, "skills"),
    settings: join(configDir, "settings.json"),
  };
}

const SHARED_PATHS = {
  skills: join(HOME, ".agents/skills"),
  zsh: join(HOME, ".config/zsh-sync/custom.zsh"),
  zshrc: join(HOME, ".zshrc"),
  zshenv: join(HOME, ".zshenv"),
  credentials: join(HOME, CREDENTIALS_ROOT),
  secrets: join(HOME, CREDENTIALS_ROOT, "secrets.zsh"),
  binDir: join(HOME, "bin"),
};

const REMOTE_SKILLS_STATE_PATH = join(STATE_HOME, "my-setup/remote-skills.json");

const USER_ZSHRC_HEADER = "# Managed shell config lives in my-setup.";
const USER_ZSHRC_IMPORT =
  '[ -f "$HOME/.config/zsh-sync/custom.zsh" ] && source "$HOME/.config/zsh-sync/custom.zsh"';
// Lines tool installers append to .zshrc that shell/zsh-custom.zsh already provides: Herd's PHP exports and
// the completion loader `bun upgrade` re-adds.
const KNOWN_TOOL_ZSHRC_LINES = [
  /^export HERD_PHP_\d+_INI_SCAN_DIR=/,
  /^\[ -s "[^"]*\/\.bun\/_bun" \] && source "[^"]*\/\.bun\/_bun"$/,
];
const ACTIVE_PROJECTS_PLACEHOLDER = "{{ACTIVE_PROJECTS}}";
const SETUP_ROOT_PLACEHOLDER = "{{SETUP_ROOT}}";

const SHARED_BIN_COMMANDS = [
  "my-setup",
  "system-tools",
  "worktree-cleanup",
  "hugeicons",
  "doctor",
  "pk",
  "share-html",
  "html-artifact",
  "store-build",
  "device-queue",
  "telegram-send",
  "heavy-run",
  "ci-runner",
  "merge-queue",
  "wait-for",
];
const MAIN_MAC_BIN_COMMANDS = ["telegram-me", "mail-read"];

// =============================================================================
// Individual Operations
// =============================================================================

// This repo's location, written the way rules show paths, such as `~/PhpstormProjects/my-setup`.
export function setupRootForRules(home = HOME, root = ROOT_DIR): string {
  const path = relative(home, root);
  // Outside home, or on another Windows drive, relative() cannot express the path from `~`.
  return path.startsWith("..") || isAbsolute(path) ? root : `~/${path.split(sep).join("/")}`;
}

export function renderBaseRules(
  template: string,
  options: { profile: DeviceProfile; setupRoot?: string; projects?: ActiveProject[] },
): string {
  const { profile, setupRoot = setupRootForRules(), projects = ACTIVE_PROJECTS } = options;
  if (!template.includes(ACTIVE_PROJECTS_PLACEHOLDER)) {
    throw new Error(`Base rules are missing ${ACTIVE_PROJECTS_PLACEHOLDER}`);
  }

  const rules = renderManagedMarkdown(template, profile.name, "content/base-rules.md");
  const activeProjects = (profile.activeProjects ? projects : [])
    .map(
      ({ name, remoteUrl, baseBranch, canonicalRoot }) =>
        `- **ACTIVE-PROJECT** — **${name}**: repository [${remoteUrl}](${remoteUrl}), base branch \`${baseBranch}\`, canonical clone at \`${canonicalRoot}\`; task worktrees are harness-managed.`,
    )
    .join("\n");

  return rules
    .replace(ACTIVE_PROJECTS_PLACEHOLDER, activeProjects)
    .replaceAll(SETUP_ROOT_PLACEHOLDER, setupRoot);
}

function knownSkillNames(): Set<string> {
  const remoteSkillNames = REMOTE_SKILL_SOURCES.flatMap((source) =>
    source.skills.map((skill) => skill.name),
  );
  const additionalSkillNames = [...remoteSkillNames, ...OPTIONAL_EXTERNAL_SKILL_NAMES];
  const localSkills = discoverLocalSkills(join(ROOT_DIR, "content", "skills"), {
    additionalSkillNames,
  });
  return new Set([...localSkills.map((skill) => skill.name), ...additionalSkillNames]);
}

function readBaseRulesTemplate(): string {
  const sourceFile = join(ROOT_DIR, "content", "base-rules.md");
  const template = readFileSync(sourceFile, "utf-8");
  const unknown = findUnknownSkillReferences(template, knownSkillNames());
  if (unknown.length > 0) {
    throw new Error(
      `Base rules reference unknown skills:\n${unknown
        .map(({ line, name }) => `- content/base-rules.md:${line} references $${name}`)
        .join("\n")}`,
    );
  }
  return template;
}

function copyRules(destination: string, label: string, profile: DeviceProfile): void {
  print.info(`Copying ${label} rules to ${destination}...`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, renderBaseRules(readBaseRulesTemplate(), { profile }));
  print.success(`${label} rules copied`);
}

function getManagedMcpServerNames(managedContent: string): Set<string> {
  return new Set(
    Array.from(managedContent.matchAll(/^\[mcp_servers\.([^\]]+)\]\s*$/gm), ([, name]) => name),
  );
}

function removeManagedMcpServers(configToml: string, managedServerNames: Set<string>): string {
  if (managedServerNames.size === 0) {
    return configToml;
  }

  const lines = configToml.split(/\r?\n/);
  const cleanedLines: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const sectionMatch = lines[index].match(/^\[mcp_servers\.([^\]]+)\]\s*$/);
    if (!sectionMatch || !managedServerNames.has(sectionMatch[1])) {
      cleanedLines.push(lines[index]);
      continue;
    }

    while (cleanedLines.at(-1)?.trim() === "") {
      cleanedLines.pop();
    }

    while (index + 1 < lines.length && !lines[index + 1].startsWith("[")) {
      index++;
    }
  }

  return cleanedLines.join("\n").trimEnd();
}

/** True when .zshrc holds only the managed import plus lines tool updaters re-add, which the managed shell config covers. */
export function onlyKnownToolAdditions(codeLines: string[]): boolean {
  const extras = codeLines.filter((line) => line !== USER_ZSHRC_IMPORT);
  return (
    codeLines.includes(USER_ZSHRC_IMPORT) &&
    extras.length > 0 &&
    extras.every((line) => KNOWN_TOOL_ZSHRC_LINES.some((pattern) => pattern.test(line)))
  );
}

async function assertThinUserZshrc(): Promise<void> {
  print.info(`Checking ${SHARED_PATHS.zshrc} stays thin...`);

  if (!existsSync(SHARED_PATHS.zshrc)) {
    print.error(`${SHARED_PATHS.zshrc} is missing.`);
    print.error(`Create it with only:\n${USER_ZSHRC_HEADER}\n${USER_ZSHRC_IMPORT}`);
    process.exit(1);
  }

  const content = await readFile(SHARED_PATHS.zshrc, "utf-8");
  const codeLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (codeLines.length === 1 && codeLines[0] === USER_ZSHRC_IMPORT) {
    print.success("User .zshrc is thin");
    return;
  }

  if (onlyKnownToolAdditions(codeLines)) {
    await writeFile(SHARED_PATHS.zshrc, `${USER_ZSHRC_HEADER}\n${USER_ZSHRC_IMPORT}\n`);
    print.success(
      "Removed the Herd or Bun lines added to .zshrc; shell/zsh-custom.zsh already provides them",
    );
    return;
  }

  print.error(`${SHARED_PATHS.zshrc} must only import ${SHARED_PATHS.zsh}.`);
  print.error("Move custom shell code into shell/zsh-custom.zsh, then run mise run install again.");
  print.error(`Expected ${SHARED_PATHS.zshrc}:\n${USER_ZSHRC_HEADER}\n${USER_ZSHRC_IMPORT}`);
  process.exit(1);
}

// =============================================================================
// Async install functions (for parallel execution)
// =============================================================================

async function installSharedSkills(profile: DeviceProfile): Promise<void> {
  const remoteSkillSources = selectRemoteSkillSources(
    validateRemoteSkillSources(REMOTE_SKILL_SOURCES),
    profile,
  );
  const src = join(ROOT_DIR, "content", "skills");
  if (!existsSync(src)) {
    print.error("Skills folder not found");
    return;
  }
  await syncManagedSkillsAsync({
    src,
    dest: SHARED_PATHS.skills,
    label: "shared skills",
    profile,
    remoteSkillSources,
  });
}

async function installOpencode(profile: DeviceProfile, rtk: boolean): Promise<void> {
  copyRules(OPENCODE_PATHS.rules, "OpenCode", profile);
  await mergeOpencodeConfigAsync(profile);
  if (!rtk) return;
  // Use the plugin bundled with the installed RTK binary; leave agent rules alone.
  await execa("rtk", ["init", "--global", "--opencode", "--hook-only", "--no-trust-filters"], {
    stdio: "pipe",
  });
  print.success("RTK OpenCode plugin installed");
}

async function mergeOpencodeConfigAsync(profile: DeviceProfile): Promise<void> {
  print.info(`Merging OpenCode config into ${OPENCODE_PATHS.config}...`);
  await ensureParentDir(OPENCODE_PATHS.config);
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(OPENCODE_PATHS.config)) {
    try {
      existingConfig = JSON.parse(await readFile(OPENCODE_PATHS.config, "utf-8"));
    } catch {
      print.warning("Failed to parse existing config, creating new file");
    }
  }
  const merged = mergeOpencodeConfig(existingConfig, profile, HOME);
  await writeFile(OPENCODE_PATHS.config, JSON.stringify(merged, null, 2) + "\n");
  const cliSettings = createOpencodeCliConfig();
  const existingCli = existsSync(OPENCODE_PATHS.cli)
    ? JSON.parse(await readFile(OPENCODE_PATHS.cli, "utf-8"))
    : {};
  await writeFile(
    OPENCODE_PATHS.cli,
    JSON.stringify(
      {
        ...existingCli,
        $schema: cliSettings.$schema,
        keybinds: { ...existingCli.keybinds, ...cliSettings.keybinds },
      },
      null,
      2,
    ) + "\n",
  );
  print.success("OpenCode config merged");
}

async function installCodex(profile: DeviceProfile): Promise<void> {
  copyRules(CODEX_PATHS.rules, "Codex", profile);
  await mergeCodexConfigAsync();
  await mergeCodexMcpConfigAsync(profile);
  await writeCodexRules(profile);
  await removeCodexHooks();
}

// Codex runs no hooks (see config/codex.ts); delete the file once only retired my-setup hooks were in it.
async function removeCodexHooks(): Promise<void> {
  if (!existsSync(CODEX_PATHS.hooks)) return;

  const { hooks, ...rest } = JSON.parse(await readFile(CODEX_PATHS.hooks, "utf-8"));
  const kept = removeRetiredHooks(hooks);

  if (Object.keys(kept).length === 0 && Object.keys(rest).length === 0) {
    await rm(CODEX_PATHS.hooks);
    print.success("Removed Codex hooks");
  } else {
    await writeFile(CODEX_PATHS.hooks, JSON.stringify({ ...rest, hooks: kept }, null, 2) + "\n");
  }
}

async function writeCodexRules(profile: DeviceProfile): Promise<void> {
  print.info(`Writing Codex execution rules to ${CODEX_PATHS.execRules}...`);
  await ensureParentDir(CODEX_PATHS.execRules);
  await writeFile(CODEX_PATHS.execRules, renderCodexRules(profile));
  print.success("Codex execution rules written");
}

async function installClaude(profile: DeviceProfile): Promise<void> {
  const paths = claudePaths(profile);

  // The pool retires the default ~/.claude files; with direct sign-in they are the install target.
  if (profile.claude === "pool") {
    for (const path of await retireLegacyClaudeFiles(HOME)) {
      print.success(`Removed old Claude config file ${path}`);
    }
  }

  copyRules(paths.rules, "Claude Code", profile);
  await installManagedSymlink(SHARED_PATHS.skills, paths.skills, "Claude Code skills");
  await mergeClaudeSettingsAsync(profile, paths.settings);
  if (profile.mcpServers) await installClaudeMcpServers(paths.configDir);
}

async function mergeClaudeSettingsAsync(
  profile: DeviceProfile,
  settingsPath: string,
): Promise<void> {
  print.info(`Merging Claude Code settings into ${settingsPath}...`);
  await ensureParentDir(settingsPath);
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(await readFile(settingsPath, "utf-8"));
    } catch {
      print.warning("Failed to parse existing Claude Code settings, creating new file");
    }
  }
  const { permissions, ...managedKeys } = createClaudeManagedSettings(profile);
  const merged = {
    ...existing,
    ...managedKeys,
    hooks: mergeClaudeHooks(existing.hooks, ROOT_DIR),
    permissions: {
      ...(existing.permissions as Record<string, unknown> | undefined),
      allow: permissions.allow,
    },
  };
  await writeFile(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  print.success("Claude Code settings merged");
}

async function installClaudeMcpServers(configDir: string): Promise<void> {
  if (!Bun.which("claude")) {
    print.warning("claude CLI not found; skipped Claude Code MCP servers");
    return;
  }
  const env = { CLAUDE_CONFIG_DIR: configDir };
  const remove = (name: string) =>
    execa("claude", ["mcp", "remove", "-s", "user", name], { env, reject: false, stdio: "pipe" });

  for (const name of RETIRED_MCP_SERVERS) await remove(name);
  for (const [name, server] of Object.entries(MCP_SERVERS)) {
    const [command, ...args] = server.command;
    await remove(name);
    await execa(
      "claude",
      ["mcp", "add-json", "-s", "user", name, JSON.stringify({ type: "stdio", command, args })],
      { env, stdio: "pipe" },
    );
  }
  print.success(`Claude Code MCP servers installed (${Object.keys(MCP_SERVERS).length})`);
}

function removeTomlTopLevelKey(configToml: string, key: string): string {
  const lines = configToml.split(/\r?\n/);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const topLevelEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  const keyIndex = lines.slice(0, topLevelEnd).findIndex((line) => keyPattern.test(line));

  if (keyIndex === -1) {
    return configToml;
  }

  lines.splice(keyIndex, 1);
  return lines.join("\n");
}

function upsertTomlTopLevelKey(configToml: string, key: string, value: string): string {
  const lines = configToml.split(/\r?\n/);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const topLevelEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  const keyIndex = lines.slice(0, topLevelEnd).findIndex((line) => keyPattern.test(line));
  const nextLine = `${key} = ${value}`;

  if (keyIndex === -1) {
    lines.unshift(nextLine);
  } else {
    lines[keyIndex] = nextLine;
  }
  return lines.join("\n");
}

function upsertTomlSectionKey(
  configToml: string,
  sectionName: string,
  key: string,
  value: string,
): string {
  const lines = configToml.trimEnd().split(/\r?\n/);
  const sectionHeader = `[${sectionName}]`;
  const sectionIndex = lines.findIndex((line) => line.trim() === sectionHeader);
  const nextLine = `${key} = ${value}`;

  if (sectionIndex === -1) {
    const trimmed = configToml.trimEnd();
    return trimmed
      ? `${trimmed}\n\n${sectionHeader}\n${nextLine}\n`
      : `${sectionHeader}\n${nextLine}\n`;
  }

  let insertIndex = lines.length;
  for (let i = sectionIndex + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      insertIndex = i;
      break;
    }

    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      lines[i] = nextLine;
      return `${lines.join("\n")}\n`;
    }
  }

  lines.splice(insertIndex, 0, nextLine);
  return `${lines.join("\n")}\n`;
}

async function mergeCodexConfigAsync(): Promise<void> {
  print.info(`Merging Codex config into ${CODEX_PATHS.config}...`);
  await ensureParentDir(CODEX_PATHS.config);
  const existing = existsSync(CODEX_PATHS.config)
    ? await readFile(CODEX_PATHS.config, "utf-8")
    : "";
  let merged = existing;
  for (const key of CODEX_RETIRED_TOP_LEVEL_KEYS) {
    merged = removeTomlTopLevelKey(merged, key);
  }
  for (const [key, value] of codexManagedTopLevelValues()) {
    merged = upsertTomlTopLevelKey(merged, key, value);
  }
  for (const [section, key, value] of codexManagedSectionValues()) {
    merged = upsertTomlSectionKey(merged, section, key, value);
  }

  const remotePool = await readRemoteCodexPool();
  if (remotePool) {
    const { topLevel, sections } = codexRemotePoolValues(remotePool.url, remotePool.clientKey);
    for (const [key, value] of topLevel) merged = upsertTomlTopLevelKey(merged, key, value);
    for (const [section, key, value] of sections) {
      merged = upsertTomlSectionKey(merged, section, key, value);
    }
  } else {
    for (const key of CODEX_REMOTE_POOL_TOP_LEVEL_KEYS) merged = removeTomlTopLevelKey(merged, key);
  }

  // The remote pool's client key lands in the config, so keep it private.
  await writeFile(CODEX_PATHS.config, merged, { mode: 0o600 });
  await chmod(CODEX_PATHS.config, 0o600);
  if (remotePool) await signInCodexToRemotePool(remotePool.clientKey);
  print.success("Codex config merged");
}

async function readRemoteCodexPool(): Promise<{ url: string; clientKey: string } | undefined> {
  const url = readRemoteClaudePoolUrl(HOME);
  if (!url) return undefined;

  const clientKey = (await readFile(claudePoolPaths(HOME).clientKey, "utf-8")).trim();
  return { url, clientKey };
}

// Codex sends its requests to the pool with the client key as its API key; the pool holds the ChatGPT sign-ins.
async function signInCodexToRemotePool(clientKey: string): Promise<void> {
  const status = await execa("codex", ["login", "status"], { reject: false, all: true });
  if (status.exitCode === 0 && /API key/i.test(status.all ?? "")) return;

  await execa("codex", ["login", "--with-api-key"], { input: clientKey });
  print.success("Codex signed in to the remote pool");
}

async function mergeCodexMcpConfigAsync(profile: DeviceProfile): Promise<void> {
  print.info(`Merging Codex MCP config into ${CODEX_PATHS.config}...`);
  const managedContent = renderCodexMcpServersToml(profile.mcpServers ? MCP_SERVERS : {}).trimEnd();
  const startMarker = "# >>> my-setup mcp >>>";
  const endMarker = "# <<< my-setup mcp <<<";
  const managedBlock = `${startMarker}\n${managedContent}\n${endMarker}\n`;
  await ensureParentDir(CODEX_PATHS.config);
  const existing = existsSync(CODEX_PATHS.config)
    ? await readFile(CODEX_PATHS.config, "utf-8")
    : "";
  const escapedStart = startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const managedPattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g");
  const previousManagedContent = Array.from(existing.matchAll(managedPattern), ([match]) =>
    match.replace(startMarker, "").replace(endMarker, ""),
  ).join("\n");
  const managedServerNames = new Set([
    ...getManagedMcpServerNames(previousManagedContent),
    ...getManagedMcpServerNames(managedContent),
  ]);
  const withoutManagedBlock = existing.replace(managedPattern, "");
  const cleaned = removeManagedMcpServers(withoutManagedBlock, managedServerNames).trimEnd();
  const merged = cleaned.length > 0 ? `${cleaned}\n\n${managedBlock}` : managedBlock;
  await writeFile(CODEX_PATHS.config, merged);
  print.success("Codex MCP config merged");
}

async function installShared(profile: DeviceProfile): Promise<void> {
  await installLocalSecrets(profile.requiredSecrets);

  const zshSource = join(ROOT_DIR, "shell", "zsh-custom.zsh");
  if (existsSync(zshSource)) {
    await installManagedSymlink(zshSource, SHARED_PATHS.zsh, "zsh config");
  } else {
    print.error("zsh-custom.zsh not found");
  }

  for (const command of SHARED_BIN_COMMANDS) {
    const sourcePath = join(ROOT_DIR, "shell", `${command}.zsh`);
    const destinationPath = join(SHARED_PATHS.binDir, command);

    if (!existsSync(sourcePath)) {
      print.error(`${command}.zsh not found`);
      continue;
    }

    await installManagedSymlink(sourcePath, destinationPath, `${command} command`);
    await chmod(sourcePath, 0o755);
  }

  // The owner's Telegram session and synced mail live only on the main Mac; Macs using a remote pool are spare Macs.
  if (profile.name === "personal" && !readRemoteClaudePoolUrl(HOME)) {
    for (const command of MAIN_MAC_BIN_COMMANDS) {
      const source = join(ROOT_DIR, "shell", `${command}.zsh`);
      await installManagedSymlink(
        source,
        join(SHARED_PATHS.binDir, command),
        `${command} command`,
      );
      await chmod(source, 0o755);
    }
  }

  print.info(`Ensuring local command paths are in PATH via ${SHARED_PATHS.zshenv}...`);
  await ensureParentDir(SHARED_PATHS.zshenv);
  const pathLines = ['export PATH="$HOME/bin:$PATH"', 'export PATH="$HOME/.local/bin:$PATH"'];
  const credentialsHomeLine = `export ${CREDENTIALS_HOME_ENV}="$HOME/${CREDENTIALS_ROOT}"`;
  const secretsSourceLine = `[[ -f "$${CREDENTIALS_HOME_ENV}/secrets.zsh" ]] && source "$${CREDENTIALS_HOME_ENV}/secrets.zsh"`;
  const zshenvContent = existsSync(SHARED_PATHS.zshenv)
    ? await readFile(SHARED_PATHS.zshenv, "utf-8")
    : "";
  let nextContent = zshenvContent.trimEnd();
  let changed = false;

  const credentialsHomePattern = new RegExp(`^export ${CREDENTIALS_HOME_ENV}=.*$`, "m");
  if (credentialsHomePattern.test(nextContent)) {
    const updatedContent = nextContent.replace(credentialsHomePattern, credentialsHomeLine);
    changed ||= updatedContent !== nextContent;
    nextContent = updatedContent;
  } else {
    nextContent = `${nextContent}\n${credentialsHomeLine}`;
    changed = true;
  }

  if (!zshenvContent.includes(secretsSourceLine)) {
    nextContent = `${nextContent}\n${secretsSourceLine}`;
    changed = true;
  }

  for (const pathLine of pathLines) {
    if (zshenvContent.includes(pathLine)) {
      continue;
    }

    nextContent = `${nextContent}\n${pathLine}`;
    changed = true;
  }

  if (changed) {
    await writeFile(SHARED_PATHS.zshenv, `${nextContent}\n`);
    print.success("Updated managed shell environment entries in .zshenv");
  } else {
    print.success("Managed shell environment entries already present in .zshenv");
  }
}

async function installManagedSymlink(src: string, dest: string, label: string): Promise<void> {
  print.info(`Linking ${label} to ${dest}...`);
  await ensureParentDir(dest);
  // Unlink an existing link itself so a recursive delete can never follow it into the linked folder.
  const existing = await lstat(dest).catch(() => undefined);
  if (existing?.isSymbolicLink()) {
    await unlink(dest);
  } else if (existing) {
    await rm(dest, { recursive: true, force: true });
  }
  // Windows only links directories here; junctions need neither admin rights nor Developer Mode.
  await symlink(src, dest, process.platform === "win32" ? "junction" : undefined);
  print.success(`${label} linked`);
}

async function installLocalSecrets(requiredSecrets: readonly string[]): Promise<void> {
  const sourceFile = join(ROOT_DIR, "config", "secrets.default.zsh");

  if (!existsSync(sourceFile)) {
    print.error("secrets.default.zsh not found");
    process.exit(1);
  }

  await secureManagedCredentials(HOME);

  if (!existsSync(SHARED_PATHS.secrets)) {
    print.info(`Creating local secrets file at ${SHARED_PATHS.secrets}...`);
    await copyFile(sourceFile, SHARED_PATHS.secrets);
    print.success("Local secrets file created");
  } else {
    print.success("Local secrets file already present");
  }

  await chmod(SHARED_PATHS.secrets, 0o600);
  await assertRequiredSecrets(requiredSecrets);
}

async function assertRequiredSecrets(requiredSecrets: readonly string[]): Promise<void> {
  try {
    const result = await execa(
      "zsh",
      [
        "-c",
        [
          'source "$MY_SETUP_SECRETS"',
          "missing=()",
          'for key in "$@"; do',
          '  [[ -n "${(P)key}" ]] || missing+=("$key")',
          "done",
          "printf '%s\\n' \"${missing[@]}\"",
        ].join("\n"),
        "my-setup-secrets",
        ...requiredSecrets,
      ],
      {
        env: {
          [CREDENTIALS_HOME_ENV]: SHARED_PATHS.credentials,
          MY_SETUP_SECRETS: SHARED_PATHS.secrets,
        },
      },
    );

    const missingSecrets = result.stdout.split(/\r?\n/).filter(Boolean);

    if (missingSecrets.length === 0) {
      print.success("Required local secrets are present");
      return;
    }

    for (const secret of missingSecrets) {
      print.error(`Missing required secret: ${secret}`);
    }
    print.error(`Edit ${SHARED_PATHS.secrets}, then run mise run install again.`);
    process.exit(1);
  } catch (error) {
    if (error instanceof Error) {
      print.error(`Failed to validate local secrets: ${error.message}`);
    } else {
      print.error("Failed to validate local secrets");
    }
    process.exit(1);
  }
}

async function configureRepoGitHooks(): Promise<void> {
  const gitDir = join(ROOT_DIR, ".git");
  const hooksDir = join(ROOT_DIR, ".githooks");

  if (!existsSync(gitDir) || !existsSync(hooksDir)) {
    return;
  }

  print.info(`Configuring repo git hooks from ${hooksDir}...`);

  try {
    await execa("git", ["config", "core.hooksPath", hooksDir], {
      cwd: ROOT_DIR,
    });
    print.success("Repo git hooks configured");
  } catch {
    print.warning("Failed to configure repo git hooks");
  }
}

interface ManagedSkillSyncOptions {
  src: string;
  dest: string;
  label: string;
  // Local skills the profile excludes are skipped, and profile blocks in Markdown are rendered for it.
  profile: DeviceProfile;
  remoteSkillSources?: RemoteSkillSource[];
}

async function containsSkillFile(dir: string, depth = 2): Promise<boolean> {
  if (existsSync(join(dir, "SKILL.md"))) {
    return true;
  }
  if (depth <= 0) {
    return false;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await containsSkillFile(join(dir, entry.name), depth - 1)) {
      return true;
    }
  }

  return false;
}

async function pruneInvalidInstalledSkillDirs(dest: string): Promise<number> {
  const entries = await readdir(dest, { withFileTypes: true });
  let removedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const installedSkillPath = join(dest, entry.name);
    // Namespace folders such as Claude's `synced/` hold skills one level down.
    if (await containsSkillFile(installedSkillPath)) {
      continue;
    }

    await rm(installedSkillPath, { recursive: true, force: true });
    removedCount++;
  }

  return removedCount;
}

async function pruneEmptyDirs(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let removedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childDir = join(dir, entry.name);
    removedCount += await pruneEmptyDirs(childDir);

    const remainingEntries = await readdir(childDir);
    if (remainingEntries.length > 0) {
      continue;
    }

    await rm(childDir, { recursive: true, force: true });
    removedCount++;
  }

  return removedCount;
}

export async function syncManagedSkillsAsync(options: ManagedSkillSyncOptions): Promise<string[]> {
  const { src, dest, label, profile, remoteSkillSources = [] } = options;
  print.info(`Syncing ${label} to ${dest} (preserving valid custom skills)...`);

  const sourceEmptyDirCount = await pruneEmptyDirs(src);
  if (sourceEmptyDirCount > 0) {
    print.warning(
      `Removed ${sourceEmptyDirCount} empty source skill director${sourceEmptyDirCount === 1 ? "y" : "ies"}`,
    );
  }

  await mkdir(dest, { recursive: true });
  const invalidSkillCount = await pruneInvalidInstalledSkillDirs(dest);
  if (invalidSkillCount > 0) {
    print.warning(
      `Removed ${invalidSkillCount} installed skill director${invalidSkillCount === 1 ? "y" : "ies"} without SKILL.md`,
    );
  }

  const remoteSkillNames = remoteSkillSources
    .flatMap((source) => source.skills.map((skill) => skill.name))
    .sort();
  // Validate references against every declared skill, so a skill may mention one this profile excludes.
  const declaredRemoteSkillNames = REMOTE_SKILL_SOURCES.flatMap((source) =>
    source.skills.map((skill) => skill.name),
  );
  const excludedSkills = new Set(profile.excludedSkills);
  const skills = discoverLocalSkills(src, {
    reportWarning: console.warn,
    additionalSkillNames: [
      ...remoteSkillNames,
      ...declaredRemoteSkillNames,
      ...OPTIONAL_EXTERNAL_SKILL_NAMES,
    ],
  }).filter((skill) => !excludedSkills.has(skill.name));
  const skillNames = skills.map((skill) => skill.name).sort();
  const managedSkillNames = [...new Set([...skillNames, ...remoteSkillNames])].sort();
  const manifestPath = join(dest, ".my-setup-managed-skills.json");
  let previousSkillNames: string[] = [];

  if (existsSync(manifestPath)) {
    try {
      const manifestContent = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
      previousSkillNames = Array.isArray(manifestContent)
        ? manifestContent.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      print.warning(`Failed to parse ${manifestPath}, rebuilding managed skill manifest`);
    }
  }

  const deletedManagedSkills = previousSkillNames.filter(
    (skillName) => !managedSkillNames.includes(skillName),
  );

  for (const skillName of deletedManagedSkills) {
    const installedSkillPath = join(dest, skillName);
    if (!existsSync(installedSkillPath)) {
      continue;
    }
    await rm(installedSkillPath, { recursive: true, force: true });
  }

  for (const skill of skills) {
    await replaceDirectory(skill.dir, join(dest, skill.name), (content, sourcePath) =>
      renderManagedMarkdown(content, profile.name, relative(src, sourcePath)),
    );
  }

  if (remoteSkillSources.length > 0) {
    const refreshDecision = await getRemoteSkillRefreshDecision({
      sources: remoteSkillSources,
      skillsDir: dest,
      statePath: REMOTE_SKILLS_STATE_PATH,
      force: process.env.MY_SETUP_REFRESH_REMOTE_SKILLS === "1",
    });

    if (refreshDecision.refresh) {
      print.info(`Refreshing remote skills (${refreshDecision.reason})...`);
      await Promise.all(remoteSkillSources.map((source) => installRemoteSkillSource(source, dest)));
      await recordRemoteSkillRefresh(remoteSkillSources, REMOTE_SKILLS_STATE_PATH);
    } else {
      print.info("Skipping remote skill refresh (refreshed within the last 24 hours)");
    }
  }

  const emptyDirCount = await pruneEmptyDirs(dest);
  if (emptyDirCount > 0) {
    print.warning(
      `Removed ${emptyDirCount} empty installed skill director${emptyDirCount === 1 ? "y" : "ies"}`,
    );
  }

  await writeFile(manifestPath, JSON.stringify(managedSkillNames, null, 2) + "\n");
  print.success(`Synced ${managedSkillNames.length} ${label}`);
  return managedSkillNames;
}

async function installRemoteSkillSource(source: RemoteSkillSource, dest: string): Promise<void> {
  const skillNames = source.skills.map((skill) => skill.name).join(", ");
  print.info(`Fetching remote skill source ${skillNames} from ${source.repository}...`);

  const tempDir = await mkdtemp(join(tmpdir(), "my-setup-skills-"));
  const repoDir = join(tempDir, "repo");

  try {
    await execa(
      "git",
      [
        "clone",
        "--depth=1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        source.ref,
        source.repository,
        repoDir,
      ],
      { stdio: "pipe" },
    );
    await execa(
      "git",
      ["sparse-checkout", "set", "--no-cone", ...source.skills.map((skill) => skill.sourcePath)],
      {
        cwd: repoDir,
        stdio: "pipe",
      },
    );

    for (const skill of source.skills) {
      await installRemoteSkill(skill, repoDir, dest);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function installRemoteSkill(
  skill: RemoteSkill,
  repoDir: string,
  dest: string,
): Promise<void> {
  const skillSrc = join(repoDir, skill.sourcePath);
  if (!existsSync(join(skillSrc, "SKILL.md"))) {
    throw new Error(`Remote skill ${skill.name} is missing SKILL.md at ${skill.sourcePath}`);
  }

  await replaceDirectory(skillSrc, join(dest, skill.name));
  const skillPath = join(dest, skill.name, "SKILL.md");
  const content = await readFile(skillPath, "utf-8");
  await writeFile(skillPath, content.replace(/^name:\s*.+$/m, `name: ${skill.name}`));
}

// =============================================================================
// Main
// =============================================================================

export async function install(): Promise<DeviceProfile> {
  assertCentralizedModels(ROOT_DIR);

  const profile = readDeviceProfile(HOME);
  const claude = claudePaths(profile);
  const rtk = profile.opencode && (await detectRtk(profile));

  if (profile.shell) await assertThinUserZshrc();
  await configureRepoGitHooks();

  await Promise.all([
    installSharedSkills(profile),
    profile.opencode && installOpencode(profile, rtk),
    installCodex(profile),
    profile.shell && installShared(profile),
    profile.claude === "pool"
      ? // The pool creates the private config dir and its proxy settings before installClaude merges into them.
        installClaudePool(HOME)
          .then(({ restartDeferred }) => {
            if (restartDeferred) {
              print.warning(
                "CLIProxyAPI update needs a restart after active Claude Pool agents finish",
              );
            } else {
              print.success("Local Claude Pool proxy installed");
            }
          })
          .then(() => Promise.all([installClaude(profile), installRaycastPoolProvider()]))
      : installClaude(profile),
    // One queue runs, on main-mac; spare Macs, the ones using a remote pool, forward to it.
    profile.macWatcher &&
      (readRemoteClaudePoolUrl(HOME)
        ? uninstallMergeQueue(HOME).then(
            (removed) =>
              removed && print.success("Removed the merge queue worker; main-mac runs the queue"),
          )
        : installMergeQueue({ home: HOME, rootDir: ROOT_DIR, bun: process.execPath })),
    profile.macWatcher &&
      installMacWatcher({ home: HOME, rootDir: ROOT_DIR, bun: process.execPath }).then(
        ({ memcapInstalled }) => {
          if (memcapInstalled) {
            print.success("memcap config and Mac watcher installed");
          } else {
            print.warning(
              "Mac watcher installed; install memcap with brew install alextitov19/memcap/memcap",
            );
          }
        },
      ),
    profile.vscodeKeymap &&
      installVscodeKeymap({ home: HOME }).then(
        ({ keybindingsPath, backupPath, extensionsInstalled }) => {
          if (backupPath)
            print.warning(`Replaced VS Code keybindings; previous file saved to ${backupPath}`);
          if (extensionsInstalled) {
            print.success(`VS Code keymap installed to ${keybindingsPath}`);
          } else {
            print.warning(
              "VS Code keybindings installed; code CLI not found, so the IntelliJ keymap extension was skipped",
            );
          }
        },
      ),
    registerXcodeApps(),
    disableSpareMacSpotlight(),
    installT3Settings({ home: HOME }).then((result) => {
      if (!result.installed) {
        print.info("T3 Code is not installed; skipped its settings");
      } else if (result.clientSettingsChanged) {
        print.warning("T3 Code app settings updated; restart T3 Code to load them");
      } else {
        print.success(`T3 Code settings installed to ${result.stateDir}`);
      }
    }),
  ]);

  return profile;
}

export const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
export const XCODE_APP = "/Applications/Xcode.app";

// Xcode 27 replaced Simulator.app with DeviceHub. An Xcode copied onto a spare Mac and never opened leaves DeviceHub unknown to
// Launch Services, so Expo cannot open a simulator after installing a build.
async function registerXcodeApps(): Promise<void> {
  if (!existsSync(join(XCODE_APP, "Contents/Applications/DeviceHub.app"))) return;
  if ((await execa("open", ["-Ra", "DeviceHub"], { reject: false })).exitCode === 0) return;

  await execa(LSREGISTER, ["-f", "-R", XCODE_APP]);
  print.success("Registered Xcode's DeviceHub with Launch Services");
}

// Spare Macs, the ones using a remote pool, keep Spotlight indexing off; it stays silent once it is off.
async function disableSpareMacSpotlight(): Promise<void> {
  if (!readRemoteClaudePoolUrl(HOME)) return;

  try {
    const changed = await disableSpotlightIndexing();
    if (changed.length > 0) print.success(`Turned off Spotlight indexing on ${changed.join(", ")}`);
  } catch {
    print.warning(
      "Spotlight indexing is on and passwordless sudo is missing; run sudo mdutil -a -i off",
    );
  }
}

// Only the Mac that runs the pool lists it in Raycast; Macs using a remote pool skip it.
async function installRaycastPoolProvider(): Promise<void> {
  if (readRemoteClaudePoolUrl(HOME)) return;

  const { installed, changed } = await installRaycastProvider(HOME);
  if (!installed) {
    print.info("Raycast is not installed; skipped its Claude pool provider");
  } else if (changed) {
    print.success(`Raycast Claude pool provider written to ${raycastProvidersPath(HOME)}`);
  } else {
    print.success("Raycast Claude pool provider is current");
  }
}

// Returns whether the RTK OpenCode plugin can be installed; a profile that requires RTK fails without it.
async function detectRtk(profile: DeviceProfile): Promise<boolean> {
  if (Bun.which("rtk")) return true;
  if (profile.rtk === "required") {
    throw new Error("RTK is required. Run brew install rtk, then rerun mise run install.");
  }
  print.warning("RTK not found; skipped the RTK OpenCode plugin");
  return false;
}

if (import.meta.main) {
  agentOutput("install", { nativeJson: false });

  install().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
