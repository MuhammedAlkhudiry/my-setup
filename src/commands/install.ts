#!/usr/bin/env bun

/**
 * Internal local installer used by `mise run install`.
 */

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
import { CREDENTIALS_HOME_ENV, CREDENTIALS_ROOT } from "../../config/credentials";
import { MCP_SERVERS } from "../../config/mcp";
import { createOpencodeConfig } from "../../config/opencode";
import { mergeRtkHooks } from "../../config/rtk";
import { renderCodexRules } from "../../config/permissions";
import {
  codexManagedSectionValues,
  codexManagedTopLevelValues,
  renderCodexMcpServersToml,
} from "../lib/codex-config";
import { replaceDirectory, ensureParentDir } from "../lib/fs";
import { claudePoolPaths, installClaudePool, retireLegacyClaudeFiles } from "../lib/claude-pool";
import { secureManagedCredentials } from "../lib/credentials";
import { readDeviceProfile, selectRemoteSkillSources } from "../lib/device";
import { installMacWatcher } from "../lib/mac-watcher";
import { colors, compactOutput, print, printBox, printSeparator } from "../lib/print";
import { renderProfileBlocks } from "../lib/profile-blocks";
import { getRemoteSkillRefreshDecision, recordRemoteSkillRefresh } from "../lib/remote-skills";
import { discoverLocalSkills, findUnknownSkillReferences } from "../lib/skills";
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
const ACTIVE_PROJECTS_PLACEHOLDER = "{{ACTIVE_PROJECTS}}";
const SETUP_ROOT_PLACEHOLDER = "{{SETUP_ROOT}}";

const SHARED_BIN_COMMANDS = ["my-setup", "system-tools", "hugeicons", "doctor", "pk", "share-html"];

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

  const rules = renderProfileBlocks(template, profile.name, "content/base-rules.md");
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
  const settings = createOpencodeConfig(profile, HOME);
  await ensureParentDir(OPENCODE_PATHS.config);
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(OPENCODE_PATHS.config)) {
    try {
      existingConfig = JSON.parse(await readFile(OPENCODE_PATHS.config, "utf-8"));
    } catch {
      print.warning("Failed to parse existing config, creating new file");
    }
  }
  const merged = {
    ...existingConfig,
    model: settings.model,
    small_model: settings.small_model,
    keybinds: {
      ...(existingConfig.keybinds as Record<string, unknown>),
      ...(settings.keybinds as Record<string, unknown>),
    },
    permission: {
      ...(existingConfig.permission as Record<string, unknown>),
      ...(settings.permission as Record<string, unknown>),
    },
    agent: {
      ...(existingConfig.agent as Record<string, unknown>),
      ...(settings.agent as Record<string, unknown>),
    },
    plugin: settings.plugin,
    mcp: settings.mcp,
    tools: {
      ...(existingConfig.tools as Record<string, boolean>),
      ...settings.tools,
    },
  };
  await writeFile(OPENCODE_PATHS.config, JSON.stringify(merged, null, 2) + "\n");
  print.success("OpenCode config merged");
}

async function installCodex(profile: DeviceProfile, rtk: boolean): Promise<void> {
  copyRules(CODEX_PATHS.rules, "Codex", profile);
  await mergeCodexConfigAsync();
  await mergeCodexMcpConfigAsync(profile);
  await writeCodexRules(profile);
  if (!rtk) return;

  const existing = existsSync(CODEX_PATHS.hooks)
    ? JSON.parse(await readFile(CODEX_PATHS.hooks, "utf-8"))
    : {};
  await writeFile(
    CODEX_PATHS.hooks,
    JSON.stringify({ ...existing, hooks: mergeRtkHooks(existing.hooks, "codex") }, null, 2) + "\n",
  );
  print.success("RTK Codex hook installed; new hooks require review in /hooks");
}

async function writeCodexRules(profile: DeviceProfile): Promise<void> {
  print.info(`Writing Codex execution rules to ${CODEX_PATHS.execRules}...`);
  await ensureParentDir(CODEX_PATHS.execRules);
  await writeFile(CODEX_PATHS.execRules, renderCodexRules(profile));
  print.success("Codex execution rules written");
}

async function installClaude(profile: DeviceProfile, rtk: boolean): Promise<void> {
  const paths = claudePaths(profile);

  // The pool retires the default ~/.claude files; with direct sign-in they are the install target.
  if (profile.claude === "pool") {
    for (const path of await retireLegacyClaudeFiles(HOME)) {
      print.success(`Removed old Claude config file ${path}`);
    }
  }

  copyRules(paths.rules, "Claude Code", profile);
  await installManagedSymlink(SHARED_PATHS.skills, paths.skills, "Claude Code skills");
  await mergeClaudeSettingsAsync(profile, paths.settings, rtk);
  if (profile.mcpServers) await installClaudeMcpServers(paths.configDir);
}

async function mergeClaudeSettingsAsync(
  profile: DeviceProfile,
  settingsPath: string,
  rtk: boolean,
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
    hooks: rtk ? mergeRtkHooks(existing.hooks, "claude") : existing.hooks,
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
  for (const [name, server] of Object.entries(MCP_SERVERS)) {
    const [command, ...args] = server.command;
    const env = { CLAUDE_CONFIG_DIR: configDir };
    await execa("claude", ["mcp", "remove", "-s", "user", name], {
      env,
      reject: false,
      stdio: "pipe",
    });
    await execa(
      "claude",
      ["mcp", "add-json", "-s", "user", name, JSON.stringify({ type: "stdio", command, args })],
      { env, stdio: "pipe" },
    );
  }
  print.success(`Claude Code MCP servers installed (${Object.keys(MCP_SERVERS).length})`);
}

function upsertTomlTopLevelKey(configToml: string, key: string, value: string): string {
  const trimmed = configToml.trimEnd();
  const lines = trimmed ? trimmed.split(/\r?\n/) : [];
  const nextLine = `${key} = ${value}`;
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const topLevelEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let i = 0; i < topLevelEnd; i++) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      lines[i] = nextLine;
      return `${lines.join("\n")}\n`;
    }
  }

  lines.splice(topLevelEnd, 0, nextLine);
  return `${lines.join("\n")}\n`;
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
  for (const [key, value] of Object.entries(codexManagedTopLevelValues())) {
    merged = upsertTomlTopLevelKey(merged, key, value);
  }
  for (const [section, key, value] of codexManagedSectionValues()) {
    merged = upsertTomlSectionKey(merged, section, key, value);
  }
  await writeFile(CODEX_PATHS.config, merged);
  print.success("Codex config merged");
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
      renderProfileBlocks(content, profile.name, relative(src, sourcePath)),
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
  const profile = readDeviceProfile(HOME);
  const claude = claudePaths(profile);
  const rtk = await detectRtk(profile);

  if (!compactOutput) {
    console.log();
    printBox("My Setup - Installer");
    console.log();
    printSeparator();
    console.log(colors.blue(`Installing from local repo for the ${profile.name} profile`));
    console.log();
    if (profile.opencode) {
      console.log(colors.blue("  OpenCode:"));
      console.log(`    Rules:    ${OPENCODE_PATHS.rules}`);
      console.log(`    Config:   ${OPENCODE_PATHS.config} (merge)`);
      console.log();
    }
    console.log(colors.blue("  Codex:"));
    console.log(`    Rules:    ${CODEX_PATHS.rules}`);
    console.log(`    Config:   ${CODEX_PATHS.config} (managed merge)`);
    console.log();
    console.log(
      colors.blue(
        `  Claude Code (${profile.claude === "pool" ? "Claude Pool" : "direct sign-in"}):`,
      ),
    );
    console.log(`    Rules:    ${claude.rules}`);
    console.log(`    Settings: ${claude.settings} (merge)`);
    console.log(`    Skills:   ${claude.skills} -> ${SHARED_PATHS.skills}`);
    console.log();
    console.log(colors.yellow("  Shared:"));
    console.log(
      `    Skills:   ${SHARED_PATHS.skills} (managed sync, prune invalid, preserve valid custom)`,
    );
    if (profile.shell) {
      console.log(`    Zsh:      ${SHARED_PATHS.zsh}`);
      console.log(`    Zshenv:   ${SHARED_PATHS.zshenv}`);
      console.log(`    Secrets:  ${SHARED_PATHS.secrets}`);
      console.log(`    Bin:      ${SHARED_PATHS.binDir} (${SHARED_BIN_COMMANDS.join(", ")})`);
    }
    if (profile.vscodeKeymap) {
      console.log(
        `    VS Code:  ${vscodeKeybindingsPath(HOME)} (replace) + IntelliJ keymap extension`,
      );
    }
    printSeparator();
    console.log();
  }

  if (profile.shell) await assertThinUserZshrc();
  await configureRepoGitHooks();

  if (!compactOutput) {
    console.log();
    console.log(colors.blue("Installing in parallel..."));
  }
  await Promise.all([
    installSharedSkills(profile),
    profile.opencode && installOpencode(profile, rtk),
    installCodex(profile, rtk),
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
          .then(() => installClaude(profile, rtk))
      : installClaude(profile, rtk),
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
  ]);

  if (!compactOutput) {
    console.log();
    printBox("Installation completed successfully!", "green");
    console.log();
  }

  return profile;
}

// Returns whether RTK hooks can be installed; a profile that requires RTK fails without a hook-capable RTK.
async function detectRtk(profile: DeviceProfile): Promise<boolean> {
  if (!Bun.which("rtk")) {
    if (profile.rtk === "required") {
      throw new Error("RTK is required. Run brew install rtk, then rerun mise run install.");
    }
    print.warning("RTK not found; skipped RTK hooks");
    return false;
  }

  // Native Codex hooks require RTK 0.50.0 or newer.
  const hookSupport = await execa("rtk", ["hook", "codex", "--help"], {
    stdio: "pipe",
    reject: false,
  });
  if (hookSupport.exitCode === 0) return true;
  if (profile.rtk === "required") {
    throw new Error(
      "RTK needs native Codex hook support. Run brew upgrade rtk, then rerun mise run install.",
    );
  }
  print.warning("RTK lacks native Codex hook support; skipped RTK hooks");
  return false;
}

if (import.meta.main) {
  install().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
