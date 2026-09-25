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
} from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { execa } from "execa";
import {
  OPTIONAL_EXTERNAL_SKILL_NAMES,
  REMOTE_SKILL_SOURCES,
  type RemoteSkill,
  type RemoteSkillSource,
} from "../../config/skills";
import { ACTIVE_PROJECTS } from "../../config/active-projects";
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
import { secureManagedCredentials } from "../lib/credentials";
import { colors, compactOutput, print, printBox, printSeparator } from "../lib/print";
import { getRemoteSkillRefreshDecision, recordRemoteSkillRefresh } from "../lib/remote-skills";
import { discoverLocalSkills, findUnknownSkillReferences } from "../lib/skills";
import { validateRemoteSkillSources } from "../lib/validation";

// =============================================================================
// Constants
// =============================================================================

const HOME = process.env.HOME || "";
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

const CLAUDE_PATHS = {
  rules: join(HOME, ".claude/CLAUDE.md"),
  skills: join(HOME, ".claude/skills"),
  settings: join(HOME, ".claude/settings.json"),
};

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
const REQUIRED_SECRETS = ["POSTHOG_CLI_API_KEY", "HUGEICONS_TOKEN"] as const;
const ACTIVE_PROJECTS_PLACEHOLDER = "{{ACTIVE_PROJECTS}}";

const SHARED_BIN_COMMANDS = [
  "my-setup",
  "system-tools",
  "hugeicons",
  "doctor",
  "knowledge",
  "pk",
  "share-html",
];

// =============================================================================
// Individual Operations
// =============================================================================

export function renderBaseRules(template: string, projects = ACTIVE_PROJECTS): string {
  if (!template.includes(ACTIVE_PROJECTS_PLACEHOLDER)) {
    throw new Error(`Base rules are missing ${ACTIVE_PROJECTS_PLACEHOLDER}`);
  }

  const activeProjects = projects
    .map(
      ({ name, remoteUrl, baseBranch, canonicalRoot }) =>
        `- **ACTIVE-PROJECT** — **${name}**: repository [${remoteUrl}](${remoteUrl}), base branch \`${baseBranch}\`, canonical clone at \`${canonicalRoot}\`; task worktrees are harness-managed.`,
    )
    .join("\n");

  return template.replace(ACTIVE_PROJECTS_PLACEHOLDER, activeProjects);
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

function copyRules(destination: string, label: string): void {
  print.info(`Copying ${label} rules to ${destination}...`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, renderBaseRules(readBaseRulesTemplate()));
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

async function installSharedSkills(): Promise<void> {
  const remoteSkillSources = validateRemoteSkillSources(REMOTE_SKILL_SOURCES);
  const src = join(ROOT_DIR, "content", "skills");
  if (!existsSync(src)) {
    print.error("Skills folder not found");
    return;
  }
  await syncManagedSkillsAsync({
    src,
    dest: SHARED_PATHS.skills,
    label: "shared skills",
    remoteSkillSources,
  });
}

async function installOpencode(): Promise<void> {
  copyRules(OPENCODE_PATHS.rules, "OpenCode");
  await mergeOpencodeConfigAsync();
  // Use the plugin bundled with the installed RTK binary; leave agent rules alone.
  await execa("rtk", ["init", "--global", "--opencode", "--hook-only", "--no-trust-filters"], {
    stdio: "pipe",
  });
  print.success("RTK OpenCode plugin installed");
}

async function mergeOpencodeConfigAsync(): Promise<void> {
  print.info(`Merging OpenCode config into ${OPENCODE_PATHS.config}...`);
  const settings = createOpencodeConfig(HOME);
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

async function installCodex(): Promise<void> {
  copyRules(CODEX_PATHS.rules, "Codex");
  await mergeCodexConfigAsync();
  await mergeCodexMcpConfigAsync();
  await writeCodexRules();
  const existing = existsSync(CODEX_PATHS.hooks)
    ? JSON.parse(await readFile(CODEX_PATHS.hooks, "utf-8"))
    : {};
  await writeFile(
    CODEX_PATHS.hooks,
    JSON.stringify({ ...existing, hooks: mergeRtkHooks(existing.hooks, "codex") }, null, 2) + "\n",
  );
  print.success("RTK Codex hook installed; new hooks require review in /hooks");
}

async function writeCodexRules(): Promise<void> {
  print.info(`Writing Codex execution rules to ${CODEX_PATHS.execRules}...`);
  await ensureParentDir(CODEX_PATHS.execRules);
  await writeFile(CODEX_PATHS.execRules, renderCodexRules());
  print.success("Codex execution rules written");
}

async function installClaude(): Promise<void> {
  copyRules(CLAUDE_PATHS.rules, "Claude Code");
  await installManagedSymlink(SHARED_PATHS.skills, CLAUDE_PATHS.skills, "Claude Code skills");
  await mergeClaudeSettingsAsync();
  await installClaudeMcpServers();
}

async function mergeClaudeSettingsAsync(): Promise<void> {
  print.info(`Merging Claude Code settings into ${CLAUDE_PATHS.settings}...`);
  await ensureParentDir(CLAUDE_PATHS.settings);
  let existing: Record<string, unknown> = {};
  if (existsSync(CLAUDE_PATHS.settings)) {
    try {
      existing = JSON.parse(await readFile(CLAUDE_PATHS.settings, "utf-8"));
    } catch {
      print.warning("Failed to parse existing Claude Code settings, creating new file");
    }
  }
  const { permissions, ...managedKeys } = createClaudeManagedSettings();
  const merged = {
    ...existing,
    ...managedKeys,
    hooks: mergeRtkHooks(existing.hooks, "claude"),
    permissions: {
      ...(existing.permissions as Record<string, unknown> | undefined),
      allow: permissions.allow,
    },
  };
  await writeFile(CLAUDE_PATHS.settings, JSON.stringify(merged, null, 2) + "\n");
  print.success("Claude Code settings merged");
}

async function installClaudeMcpServers(): Promise<void> {
  if (!Bun.which("claude")) {
    print.warning("claude CLI not found; skipped Claude Code MCP servers");
    return;
  }
  for (const [name, server] of Object.entries(MCP_SERVERS)) {
    const [command, ...args] = server.command;
    await execa("claude", ["mcp", "remove", "-s", "user", name], { reject: false, stdio: "pipe" });
    await execa(
      "claude",
      ["mcp", "add-json", "-s", "user", name, JSON.stringify({ type: "stdio", command, args })],
      { stdio: "pipe" },
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

async function mergeCodexMcpConfigAsync(): Promise<void> {
  print.info(`Merging Codex MCP config into ${CODEX_PATHS.config}...`);
  const managedContent = renderCodexMcpServersToml().trimEnd();
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

async function installShared(): Promise<void> {
  await installLocalSecrets();

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
  await rm(dest, { recursive: true, force: true });
  await symlink(src, dest);
  print.success(`${label} linked`);
}

async function installLocalSecrets(): Promise<void> {
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
  await assertRequiredSecrets();
}

async function assertRequiredSecrets(): Promise<void> {
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
        ...REQUIRED_SECRETS,
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
  const { src, dest, label, remoteSkillSources = [] } = options;
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
  const skills = discoverLocalSkills(src, {
    reportWarning: console.warn,
    additionalSkillNames: [...remoteSkillNames, ...OPTIONAL_EXTERNAL_SKILL_NAMES],
  });
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
    await replaceDirectory(skill.dir, join(dest, skill.name));
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

export async function install(): Promise<void> {
  if (!Bun.which("rtk")) {
    throw new Error("RTK is required. Run brew install rtk, then rerun mise run install.");
  }
  // Native Codex hooks require RTK 0.50.0 or newer.
  await execa("rtk", ["hook", "codex", "--help"], { stdio: "pipe" }).catch(() => {
    throw new Error(
      "RTK needs native Codex hook support. Run brew upgrade rtk, then rerun mise run install.",
    );
  });
  if (!compactOutput) {
    console.log();
    printBox("My Setup - Installer");
    console.log();
    printSeparator();
    console.log(colors.blue("Installing from local repo"));
    console.log();
    console.log(colors.blue("  OpenCode:"));
    console.log(`    Rules:    ${OPENCODE_PATHS.rules}`);
    console.log(`    Config:   ${OPENCODE_PATHS.config} (merge)`);
    console.log();
    console.log(colors.blue("  Codex:"));
    console.log(`    Rules:    ${CODEX_PATHS.rules}`);
    console.log(`    Config:   ${CODEX_PATHS.config} (managed merge)`);
    console.log();
    console.log(colors.blue("  Claude Code:"));
    console.log(`    Rules:    ${CLAUDE_PATHS.rules}`);
    console.log(`    Skills:   ${CLAUDE_PATHS.skills} -> ${SHARED_PATHS.skills}`);
    console.log();
    console.log(colors.yellow("  Shared:"));
    console.log(
      `    Skills:   ${SHARED_PATHS.skills} (managed sync, prune invalid, preserve valid custom)`,
    );
    console.log(`    Zsh:      ${SHARED_PATHS.zsh}`);
    console.log(`    Zshenv:   ${SHARED_PATHS.zshenv}`);
    console.log(`    Secrets:  ${SHARED_PATHS.secrets}`);
    console.log(`    Bin:      ${SHARED_PATHS.binDir} (${SHARED_BIN_COMMANDS.join(", ")})`);
    printSeparator();
    console.log();
  }

  await assertThinUserZshrc();
  await configureRepoGitHooks();

  if (!compactOutput) {
    console.log();
    console.log(colors.blue("Installing in parallel..."));
  }
  await Promise.all([
    installSharedSkills(),
    installOpencode(),
    installCodex(),
    installClaude(),
    installShared(),
  ]);

  if (!compactOutput) {
    console.log();
    printBox("Installation completed successfully!", "green");
    console.log();
  }
}

if (import.meta.main) {
  install().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
