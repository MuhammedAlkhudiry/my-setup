import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { execa } from "execa";

import { CLAUDE_POOL } from "../../config/claude-pool";

export function claudePoolPaths(home: string) {
  const proxyDir = join(home, ".cli-proxy-api");
  return {
    binary: join(home, ".local/bin/cliproxyapi"),
    config: join(proxyDir, "config.yaml"),
    clientKey: join(proxyDir, "client-key"),
    managementKey: join(proxyDir, "management-key"),
    authDir: join(proxyDir, "auth"),
    claudeDir: join(home, ".claude_cliproxy"),
    claudeSettings: join(home, ".claude_cliproxy/settings.json"),
    launchAgent: join(home, "Library/LaunchAgents", `${CLAUDE_POOL.label}.plist`),
    stdoutLog: join(home, "Library/Logs/CLIProxyAPI.log"),
    stderrLog: join(home, "Library/Logs/CLIProxyAPI.error.log"),
  };
}

type PoolPaths = ReturnType<typeof claudePoolPaths>;

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertRegularFile(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular file at ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a directory at ${path}`);
  await chmod(path, 0o700);
}

async function privateFile(path: string, content: string): Promise<boolean> {
  await assertRegularFile(path);
  const previous = await readOptional(path);
  if (previous === content) {
    await chmod(path, 0o600);
    return false;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "my-setup-claude-pool-"));
  try {
    const tempFile = join(tempDir, "file");
    await writeFile(tempFile, content, { mode: 0o600 });
    try {
      await rename(tempFile, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(tempFile, path);
    }
    await chmod(path, 0o600);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  return true;
}

async function localKey(path: string): Promise<string> {
  await assertRegularFile(path);
  const existing = await readOptional(path);
  if (existing !== undefined) {
    const key = existing.trim();
    if (!key) throw new Error(`Empty Claude pool key at ${path}`);
    await chmod(path, 0o600);
    return key;
  }

  const key = randomBytes(32).toString("hex");
  try {
    await writeFile(path, `${key}\n`, { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return localKey(path);
    throw error;
  }
}

async function managementHash(configPath: string, key: string): Promise<string> {
  const existing = await readOptional(configPath);
  const encoded = existing?.match(/^  secret-key: (.+)$/m)?.[1];
  if (encoded) {
    try {
      const hash: unknown = JSON.parse(encoded);
      if (typeof hash === "string" && (await Bun.password.verify(key, hash))) return hash;
    } catch {
      // A changed or invalid local hash is replaced using the preserved management key.
    }
  }
  return Bun.password.hash(key, { algorithm: "bcrypt", cost: 10 });
}

export function renderClaudePoolConfig(
  paths: PoolPaths,
  clientKey: string,
  managementKeyHash: string,
): string {
  return [
    "config-version: 8",
    "server:",
    '  host: "127.0.0.1"',
    `  port: ${CLAUDE_POOL.port}`,
    "  discovery:",
    "    enabled: false",
    "management:",
    "  allow-remote: false",
    `  secret-key: ${JSON.stringify(managementKeyHash)}`,
    "  disable-control-panel: false",
    "access:",
    "  api-keys:",
    `    - ${JSON.stringify(clientKey)}`,
    "routing:",
    '  strategy: "round-robin"',
    "  session-affinity: true",
    '  session-affinity-ttl: "1h"',
    "  session-affinity-subagents: false",
    "oauth:",
    `  auth-dir: ${JSON.stringify(paths.authDir)}`,
    "observability:",
    "  logs:",
    "    debug: false",
    "    logging-to-file: false",
    "    request-log: false",
    "  usage:",
    "    usage-statistics-enabled: true",
    "oauth-model-alias:",
    "  claude:",
    '    - name: "claude-haiku-4-5-20251001"',
    '      alias: "claude-haiku-4-5"',
    "      fork: true",
    '    - name: "claude-opus-4-5-20251101"',
    '      alias: "claude-opus-4-5"',
    "      fork: true",
    "",
  ].join("\n");
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const escapes: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return escapes[character];
  });
}

export function renderClaudePoolLaunchAgent(paths: PoolPaths): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${CLAUDE_POOL.label}</string>`,
    "  <key>ProgramArguments</key><array>",
    `    <string>${xmlEscape(paths.binary)}</string>`,
    "    <string>-config</string>",
    `    <string>${xmlEscape(paths.config)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>StandardOutPath</key><string>${xmlEscape(paths.stdoutLog)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(paths.stderrLog)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

export async function prepareClaudePoolFiles(home: string): Promise<{ plistChanged: boolean }> {
  const paths = claudePoolPaths(home);
  await privateDirectory(dirname(paths.config));
  await privateDirectory(paths.authDir);
  await privateDirectory(paths.claudeDir);
  await mkdir(dirname(paths.launchAgent), { recursive: true });
  await mkdir(dirname(paths.stdoutLog), { recursive: true });

  const clientKey = await localKey(paths.clientKey);
  const managementKey = await localKey(paths.managementKey);
  const hash = await managementHash(paths.config, managementKey);
  await privateFile(paths.config, renderClaudePoolConfig(paths, clientKey, hash));

  const existingSettings = await readOptional(paths.claudeSettings);
  const parsed: unknown = existingSettings ? JSON.parse(existingSettings) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Claude pool settings at ${paths.claudeSettings}`);
  }
  const settings = parsed as Record<string, unknown>;
  const currentEnv = settings.env;
  if (currentEnv && (typeof currentEnv !== "object" || Array.isArray(currentEnv))) {
    throw new Error(`Invalid Claude pool environment at ${paths.claudeSettings}`);
  }
  settings.env = {
    ...(currentEnv as Record<string, unknown> | undefined),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${CLAUDE_POOL.port}`,
    ANTHROPIC_AUTH_TOKEN: clientKey,
    ANTHROPIC_API_KEY: "",
  };
  await privateFile(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`);

  const plistChanged = await privateFile(paths.launchAgent, renderClaudePoolLaunchAgent(paths));
  for (const log of [paths.stdoutLog, paths.stderrLog]) {
    if (!existsSync(log)) await writeFile(log, "", { flag: "wx", mode: 0o600 });
    await chmod(log, 0o600);
  }
  return { plistChanged };
}

export async function ensureClaudePoolBinary(home: string): Promise<boolean> {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("The Claude pool installer supports macOS arm64 and x64 only");
  }

  const paths = claudePoolPaths(home);
  if (existsSync(paths.binary)) {
    const version = await execa(paths.binary, ["-h"], { reject: false });
    if (`${version.stdout}\n${version.stderr}`.includes(`CLIProxyAPI Version: ${CLAUDE_POOL.version}`)) {
      return false;
    }
  }

  const asset = CLAUDE_POOL.releaseAssets[process.arch as "arm64" | "x64"];
  const url = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLAUDE_POOL.version}/${asset.name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`CLIProxyAPI release download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== asset.sha256) {
    throw new Error("CLIProxyAPI release checksum mismatch");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "my-setup-claude-pool-"));
  try {
    const archivePath = join(tempDir, asset.name);
    await writeFile(archivePath, archive, { mode: 0o600 });
    await execa("tar", ["-xzf", archivePath, "-C", tempDir, "cli-proxy-api"]);
    const extracted = join(tempDir, "cli-proxy-api");
    if (!(await stat(extracted)).isFile()) throw new Error("CLIProxyAPI release has no binary");
    await chmod(extracted, 0o755);
    await mkdir(dirname(paths.binary), { recursive: true });
    try {
      await rename(extracted, paths.binary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(extracted, paths.binary);
    }
    await chmod(paths.binary, 0o755);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  return true;
}

export async function installClaudePool(home: string): Promise<{ restartDeferred: boolean }> {
  const binaryChanged = await ensureClaudePoolBinary(home);
  const { plistChanged } = await prepareClaudePoolFiles(home);
  const paths = claudePoolPaths(home);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Claude Pool launch agent requires macOS");
  const service = `gui/${uid}/${CLAUDE_POOL.label}`;
  const current = await execa("launchctl", ["print", service], { reject: false });
  if (current.exitCode !== 0) {
    await execa("launchctl", ["bootstrap", `gui/${uid}`, paths.launchAgent]);
    return { restartDeferred: false };
  }
  if (!current.stdout.includes("state = running")) {
    await execa("launchctl", ["kickstart", service]);
    return { restartDeferred: false };
  }
  return { restartDeferred: binaryChanged || plistChanged };
}
