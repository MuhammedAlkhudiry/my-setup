#!/usr/bin/env bun

/**
 * Local hygiene checks used by `doctor`. Prints one `<level>\t<label>: <detail>` line per finding.
 */

import { agentOutput } from "../lib/agent-output";
import { cfAuthProblem } from "../lib/cf-auth";
import { readMergeQueue } from "../lib/merge-queue";
import { workerShellArguments, WORKER_TOOL_PROBE } from "../lib/merge-queue-environment";

import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statfsSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";

import { ACTIVE_PROJECTS, SHARED_VERIFICATION } from "../../config/active-projects";
import { CLAUDE_POOL } from "../../config/claude-pool";
import { MODELS } from "../../config/models";
import { createOpencodeCliConfig, mergeOpencodeConfig } from "../../config/opencode";
import { DEVICE_POOL } from "../../config/device-pool";
import { MAC_WATCHER, MEMCAP_LAUNCH_AGENT_LABEL } from "../../config/mac-watcher";
import { claudePoolPaths, findLegacyClaudeFiles } from "../lib/claude-pool";
import {
  fileAgeSeconds,
  macWatcherPaths,
  readAlerts,
  readState,
  renderMemcapConfig,
} from "../lib/mac-watcher";
import { readDeviceProfile, readRemoteClaudePoolUrl } from "../lib/device";
import { DEVICE_QUEUE } from "../lib/device-queue";
import { checkRaycastProvider, RAYCAST_APP, raycastProvidersPath } from "../lib/raycast";
import { parsePruneReport } from "../lib/storage-prune";
import { hasTelegramMeSession } from "../lib/telegram-me";
import { cleanupDoctorHint } from "../lib/worktree-cleanup";
import { claudePaths, LSREGISTER, renderBaseRules, XCODE_APP } from "./install";

if (process.env.MY_SETUP_DOCTOR_DETAIL !== "1") {
  agentOutput("doctor-checks", { failures: (output) => output.trim().split("\n").filter(Boolean) });
}

const ROOT_DIR = join(import.meta.dir, "..", "..");
const HOME = homedir();
const MIN_FREE_GIB = 20;

const PROFILE = readDeviceProfile(HOME);

const INSTALLED_RULES_FILES = [
  { label: "Claude Code", path: claudePaths(PROFILE).rules },
  { label: "Codex", path: join(HOME, ".codex/AGENTS.md") },
  ...(PROFILE.opencode
    ? [{ label: "OpenCode", path: join(HOME, ".config/opencode/AGENTS.md") }]
    : []),
];

interface Finding {
  level: "required" | "optional";
  label: string;
  detail: string;
}

const findings: Finding[] = [];

const avdRoot = join(HOME, ".android/avd");
const configuredAvds = existsSync(avdRoot)
  ? readdirSync(avdRoot).filter((name) => name.endsWith(".ini"))
  : [];
if (configuredAvds.length < DEVICE_QUEUE.maxRunning.android) {
  findings.push({
    level: "optional",
    label: "Android emulator slots",
    detail: `${DEVICE_QUEUE.maxRunning.android} slots but ${configuredAvds.length} AVDs; create another AVD or lower DEVICE_QUEUE_ANDROID_SLOTS`,
  });
}

for (const project of new Set(DEVICE_POOL.map((member) => member.project))) {
  const simulators = DEVICE_POOL.filter(
    (member) => member.project === project && member.platform === "ios",
  ).length;
  if (simulators < DEVICE_QUEUE.maxRunning.ios) {
    findings.push({
      level: "optional",
      label: "iOS device pool",
      detail: `${project} has ${simulators} pool simulators for ${DEVICE_QUEUE.maxRunning.ios} iOS slots; add members to config/device-pool.ts or lower DEVICE_QUEUE_IOS_SLOTS`,
    });
  }
}

const avdFolders = existsSync(avdRoot)
  ? readdirSync(avdRoot).filter((name) => name.endsWith(".avd"))
  : [];
const orphanAvds = avdFolders.filter(
  (name) => !configuredAvds.includes(name.replace(/\.avd$/, ".ini")),
);
if (orphanAvds.length) {
  findings.push({
    level: "optional",
    label: "Orphan AVD folders",
    detail: `${orphanAvds.join(", ")} in ${avdRoot} have no .ini; delete them`,
  });
}
const missingAvds = DEVICE_POOL.filter(
  (member) => member.platform === "android" && !configuredAvds.includes(`${member.name}.ini`),
);
if (existsSync(avdRoot) && missingAvds.length) {
  findings.push({
    level: "optional",
    label: "Device pool AVDs",
    detail: `missing ${missingAvds.map((member) => member.name).join(", ")}; create with avdslim create`,
  });
}

// Agents lease the pool through device-queue; any other simulator is a per-task copy that pays first-boot setup again.
const simulators = (() => {
  try {
    const { devices } = JSON.parse(execaSync("xcrun", ["simctl", "list", "devices", "-j"]).stdout);
    return Object.values(devices as Record<string, Array<{ name: string }>>).flat();
  } catch {
    return [];
  }
})();
const poolNames = new Set(DEVICE_POOL.map((member) => member.name));
const straySimulators = simulators.filter((simulator) => !poolNames.has(simulator.name));
if (straySimulators.length) {
  findings.push({
    level: "optional",
    label: "Simulators outside the device pool",
    detail: `${straySimulators.map((simulator) => simulator.name).join(", ")}; delete with xcrun simctl delete <udid> or add them to config/device-pool.ts`,
  });
}

if (
  existsSync(join(XCODE_APP, "Contents/Applications/DeviceHub.app")) &&
  execaSync("open", ["-Ra", "DeviceHub"], { reject: false }).exitCode !== 0
) {
  findings.push({
    level: "required",
    label: "Xcode DeviceHub",
    detail: `Launch Services cannot find DeviceHub, so Expo cannot open simulators; run ${LSREGISTER} -f -R ${XCODE_APP}`,
  });
}

const zshCustom = readFileSync(join(ROOT_DIR, "shell", "zsh-custom.zsh"), "utf-8");
if (/^\s*(alias\s+zsh=|zsh\s*\(\)|function\s+zsh\b)/m.test(zshCustom)) {
  findings.push({
    level: "required",
    label: "zsh shadowed",
    detail: "shell/zsh-custom.zsh redefines zsh; scripts run as `zsh file.zsh` silently do nothing",
  });
}

for (const root of [
  ROOT_DIR,
  ...(PROFILE.activeProjects ? ACTIVE_PROJECTS.map((project) => project.canonicalRoot) : []),
]) {
  if (!existsSync(join(root, ".git"))) continue;
  const result = execaSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    reject: false,
    timeout: 200,
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

if (PROFILE.activeProjects) {
  const detail = await cleanupDoctorHint(HOME);
  if (detail) findings.push({ level: "optional", label: "worktree storage", detail });
}

const expectedRules = renderBaseRules(
  readFileSync(join(ROOT_DIR, "content", "base-rules.md"), "utf-8"),
  { profile: PROFILE },
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
      .join(", ")} differ from content/base-rules.md; run mise run install`,
  });
}

const rtkPlugin = join(HOME, ".config/opencode/plugins/rtk.ts");
let rtkPluginValid = false;
if (PROFILE.opencode) {
  const version = execaSync("opencode", ["--version"], { reject: false, timeout: 10_000 });
  if (version.exitCode !== 0 || !/\bv2\./.test(version.stdout)) {
    findings.push({
      level: "required",
      label: "OpenCode version",
      detail: "OpenCode 2 is required; run opencode upgrade --major",
    });
  }
  try {
    const config = JSON.parse(readFileSync(join(HOME, ".config/opencode/opencode.json"), "utf-8"));
    const cli = JSON.parse(readFileSync(join(HOME, ".config/opencode/cli.json"), "utf-8"));
    const expectedCli = createOpencodeCliConfig();
    if (
      JSON.stringify(config) !== JSON.stringify(mergeOpencodeConfig(config, PROFILE, HOME)) ||
      cli.$schema !== expectedCli.$schema ||
      Object.entries(expectedCli.keybinds).some(([key, value]) => cli.keybinds?.[key] !== value)
    ) {
      throw new Error("managed settings differ");
    }
  } catch {
    findings.push({
      level: "required",
      label: "OpenCode config",
      detail: "managed server or CLI settings are missing or stale; run mise run install",
    });
  }
}
if (PROFILE.opencode && existsSync(rtkPlugin)) {
  try {
    const { default: plugin } = await import(rtkPlugin);
    await plugin.setup({
      tool: {
        hook: async (name: string, callback: unknown) => {
          rtkPluginValid = name === "execute.before" && typeof callback === "function";
        },
      },
    });
  } catch {
    // A plugin that cannot load or register its hook is unusable.
  }
}
if (PROFILE.opencode && !rtkPluginValid) {
  findings.push({
    level: "required",
    label: "RTK OpenCode plugin",
    detail: `${rtkPlugin} is missing or invalid; run mise run install`,
  });
}

const pool = claudePoolPaths(HOME);
const remotePoolUrl = readRemoteClaudePoolUrl(HOME);
if (remotePoolUrl) {
  // This Mac uses another Mac's pool: check the copied key, the settings, and that the pool answers.
  try {
    const clientKey = readFileSync(pool.clientKey, "utf8").trim();
    const settings = JSON.parse(readFileSync(pool.claudeSettings, "utf8"));
    if (
      !clientKey ||
      settings.env?.ANTHROPIC_BASE_URL !== remotePoolUrl ||
      settings.env?.ANTHROPIC_AUTH_TOKEN !== clientKey ||
      settings.env?.ANTHROPIC_API_KEY !== ""
    ) {
      throw new Error("Claude settings do not match the remote pool");
    }
    const models = execaSync(
      "curl",
      [
        "-sf",
        "-m",
        "5",
        "-o",
        "/dev/null",
        "-H",
        `Authorization: Bearer ${clientKey}`,
        `${remotePoolUrl}/v1/models`,
      ],
      { reject: false },
    );
    if (models.exitCode !== 0) {
      findings.push({
        level: "required",
        label: "Claude pool",
        detail: `${remotePoolUrl} does not answer; check Tailscale and the pool Mac`,
      });
    }
  } catch {
    findings.push({
      level: "required",
      label: "Claude pool credentials",
      detail: "copy the pool Mac's ~/.cli-proxy-api/client-key here, then run mise run install",
    });
  }

  // Codex reaches the same pool with the client key as its API key.
  const codexConfig = existsSync(join(HOME, ".codex/config.toml"))
    ? readFileSync(join(HOME, ".codex/config.toml"), "utf8")
    : "";
  const codexLogin = execaSync("codex", ["login", "status"], { reject: false, all: true });
  if (
    !codexConfig.includes(`openai_base_url = "${remotePoolUrl}/v1"`) ||
    !/API key/i.test(codexLogin.all ?? "")
  ) {
    findings.push({
      level: "required",
      label: "Codex pool",
      detail: "Codex is not signed in to the remote pool; run mise run install",
    });
  }
} else {
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
      findings.push({
        level: "required",
        label: "Claude pool permissions",
        detail: `${path} must be a private mode-600 file`,
      });
    }
  }
  for (const path of [join(HOME, ".cli-proxy-api"), pool.authDir, pool.claudeDir]) {
    const dir = lstatSync(path, { throwIfNoEntry: false });
    if (!dir || !dir.isDirectory() || (dir.mode & 0o777) !== 0o700) {
      findings.push({
        level: "required",
        label: "Claude pool permissions",
        detail: `${path} must be a private mode-700 directory`,
      });
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
      Object.values(MODELS.claudePool).some(
        ({ id, alias }) =>
          !config.includes(`name: ${JSON.stringify(id)}`) ||
          !config.includes(`alias: ${JSON.stringify(alias)}`),
      )
    ) {
      findings.push({
        level: "required",
        label: "Claude pool configuration",
        detail:
          "local routing, dashboard, or model aliases differ from the managed setup; run mise run install",
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
        detail: "isolated Claude settings do not match the local client key; run mise run install",
      });
    }
  }

  const legacyClaudeFiles = findLegacyClaudeFiles(HOME);
  if (legacyClaudeFiles.length > 0) {
    findings.push({
      level: "required",
      label: "old Claude config",
      detail: `${legacyClaudeFiles.join(", ")} would load stale rules in Claude Pool sessions; run mise run install`,
    });
  }

  const poolService = execaSync(
    "launchctl",
    ["print", `gui/${process.getuid?.() ?? 0}/${CLAUDE_POOL.label}`],
    {
      reject: false,
    },
  );
  if (poolService.exitCode !== 0 || !poolService.stdout.includes("state = running")) {
    findings.push({
      level: "optional",
      label: "Claude pool service",
      detail: "launch agent is not running; run mise run install",
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
    const accounts = readdirSync(pool.authDir).filter((name) =>
      /^claude-.+\.json$/.test(name),
    ).length;
    if (accounts < 2) {
      findings.push({
        level: "optional",
        label: "Claude pool accounts",
        detail: `found ${accounts} Claude OAuth credential files; authenticate the other account locally`,
      });
    }
  }

  // Raycast AI lists the pool as a custom provider and calls it with the client key.
  if (PROFILE.claude === "pool" && existsSync(RAYCAST_APP) && existsSync(pool.clientKey)) {
    const clientKey = readFileSync(pool.clientKey, "utf8").trim();
    const providersPath = raycastProvidersPath(HOME);
    const providerProblem = existsSync(providersPath)
      ? checkRaycastProvider(readFileSync(providersPath, "utf8"), clientKey)
      : "is missing";
    if (providerProblem) {
      findings.push({
        level: "optional",
        label: "Raycast Claude pool",
        detail: `${providersPath} ${providerProblem}; run mise run install`,
      });
    } else if ((statSync(providersPath).mode & 0o777) !== 0o600) {
      findings.push({
        level: "required",
        label: "Raycast Claude pool",
        detail: `${providersPath} holds the pool key and must be a private mode-600 file`,
      });
    }

    const models = execaSync(
      "curl",
      [
        "-sf",
        "-m",
        "5",
        "-o",
        "/dev/null",
        "-H",
        `Authorization: Bearer ${clientKey}`,
        `http://127.0.0.1:${CLAUDE_POOL.port}/v1/models`,
      ],
      { reject: false },
    );
    if (models.exitCode !== 0) {
      findings.push({
        level: "required",
        label: "Claude pool",
        detail: `/v1/models does not answer with the client key on port ${CLAUDE_POOL.port}; check the launch agent`,
      });
    }
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
        detail:
          "disable the default Claude provider in T3 Code Settings > Providers; Claude runs only through Claude Pool",
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
      detail:
        "add the Claude Pool instance in T3 Code Settings > Providers with CLAUDE_CONFIG_DIR ~/.claude_cliproxy",
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

// share-html refreshes cf's OAuth token near its expiry, so the sign-in must be refreshable.
const cfAuth = process.env.CLOUDFLARE_API_TOKEN ? undefined : cfAuthProblem();
if (cfAuth) findings.push({ level: "required", label: "Cloudflare sign-in", detail: cfAuth });

const ssdLinks = [
  { path: join(HOME, ".android/avd"), label: "Android emulators offline" },
  { path: join(HOME, ".gradle"), label: "Gradle cache offline" },
];
for (const { path, label } of ssdLinks) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(path)) {
    findings.push({
      level: "optional",
      label,
      detail: `${path} points to ${readlinkSync(path)}, which is not mounted; connect the SSD`,
    });
  }
}

const watcher = macWatcherPaths(HOME);
const launchd = (label: string) =>
  execaSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], { reject: false })
    .exitCode === 0;
if (
  !existsSync(watcher.memcapConfig) ||
  readFileSync(watcher.memcapConfig, "utf8") !== renderMemcapConfig()
) {
  findings.push({
    level: "required",
    label: "memcap config",
    detail: `${watcher.memcapConfig} differs from config/mac-watcher.ts; run mise run install`,
  });
}
if (Bun.which("memcap")) {
  const memcapAge = fileAgeSeconds(watcher.memcapLastPass);
  if (!launchd(MEMCAP_LAUNCH_AGENT_LABEL)) {
    findings.push({
      level: "required",
      label: "memcap service",
      detail: "not loaded; run memcap service install",
    });
  } else if (existsSync(watcher.memcapPaused)) {
    findings.push({
      level: "optional",
      label: "memcap paused",
      detail: "cleanup is off; resume with memcap on",
    });
  } else if (memcapAge !== undefined && memcapAge > 600) {
    findings.push({
      level: "required",
      label: "memcap heartbeat",
      detail: `last pass ${Math.round(memcapAge / 60)} min ago; check memcap status and ~/.local/state/memcap/actions.log`,
    });
  }
}
const guardAge = fileAgeSeconds(watcher.guardState);
if (!launchd(MAC_WATCHER.guardLabel)) {
  findings.push({
    level: "required",
    label: "CPU guard service",
    detail: "launch agent is not loaded; run mise run install",
  });
} else if (guardAge === undefined || guardAge > 600) {
  findings.push({
    level: "required",
    label: "CPU guard heartbeat",
    detail: `no guard pass in 10 min; see ${watcher.log}`,
  });
}
if (!launchd(MAC_WATCHER.label)) {
  findings.push({
    level: "required",
    label: "Mac watcher service",
    detail: "launch agent is not loaded; run mise run install",
  });
}
try {
  const state = readState(watcher);
  const lastSuccess = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : undefined;
  if (state.lastRunAt && (!lastSuccess || Date.now() - lastSuccess > 26 * 3_600_000)) {
    findings.push({
      level: "optional",
      label: "Mac watcher runs",
      detail: `no successful run in 26 hours${state.lastError ? ` (last error: ${state.lastError})` : ""}; see ${watcher.log}`,
    });
  }
  for (const alert of readAlerts(watcher).filter((candidate) => candidate.status === "open")) {
    findings.push({
      level: "optional",
      label: `Mac watcher alert ${alert.key}`,
      detail: `[${alert.severity}] ${alert.title}. Fix: ${alert.fix} Closes after ${MAC_WATCHER.autoResolveAfterClearRuns} clear runs, or run mise run watcher -- resolve ${alert.key}`,
    });
  }
} catch (error) {
  findings.push({ level: "optional", label: "Mac watcher state", detail: String(error) });
}
try {
  if (existsSync(watcher.storagePrune)) {
    const prune = parsePruneReport(JSON.parse(readFileSync(watcher.storagePrune, "utf8")));
    if (Date.now() - Date.parse(prune.at) > 26 * 3_600_000) {
      findings.push({
        level: "optional",
        label: "Dependency pruning",
        detail: `last storage pass ${prune.at}; see ${watcher.log}`,
      });
    }
    for (const problem of [...prune.skipped, ...prune.errors]) {
      findings.push({
        level: "optional",
        label: "Storage prune",
        detail: `${problem} (run ${prune.at})`,
      });
    }
    // Idle worktrees the rules cannot remove safely need a person to decide.
    for (const kept of prune.worktreesKept.filter(
      (worktree) => worktree.idleDays >= MAC_WATCHER.storage.worktreeIdleDays.abandoned,
    )) {
      findings.push({
        level: "optional",
        label: "Stale worktree",
        detail: `${kept.path} idle ${kept.idleDays}d, kept because ${kept.reason}`,
      });
    }
  } else if (existsSync(watcher.state)) {
    findings.push({
      level: "optional",
      label: "Dependency pruning",
      detail: `no storage pass recorded; see ${watcher.log}`,
    });
  }
} catch (error) {
  findings.push({ level: "optional", label: "Storage prune state", detail: String(error) });
}

// Reads each project's last fetched base branch, so it needs no network and reports drift as of the last fetch.
if (PROFILE.activeProjects) {
  const show = (project: (typeof ACTIVE_PROJECTS)[number], path: string) => {
    const result = execaSync("git", ["show", `origin/${project.baseBranch}:${path}`], {
      cwd: project.canonicalRoot,
      reject: false,
    });

    return result.exitCode === 0 ? result.stdout : null;
  };
  const projects = ACTIVE_PROJECTS.filter((project) =>
    existsSync(join(project.canonicalRoot, ".git")),
  );
  const [reference, ...others] = projects;

  for (const project of reference ? others : []) {
    const drift = SHARED_VERIFICATION.files.filter(
      (path) => show(project, path) !== show(reference, path),
    );
    const descriptions = (target: typeof project) => {
      const manifest = Bun.TOML.parse(show(target, "mise.toml") ?? "") as {
        tasks?: Record<string, { description?: string }>;
      };
      const tasks = manifest.tasks;

      return SHARED_VERIFICATION.tasks.map((task) => tasks?.[task]?.description ?? null);
    };
    const theirs = descriptions(project);
    const ours = descriptions(reference);
    drift.push(
      ...SHARED_VERIFICATION.tasks
        .filter((task, index) => theirs[index] !== ours[index])
        .map((task) => `mise task ${task}`),
    );

    if (drift.length > 0) {
      findings.push({
        level: "optional",
        label: "Verification parity",
        detail: `${project.name} differs from ${reference.name} in ${drift.join(", ")}; copy the shared version to both`,
      });
    }
  }
}

if (PROFILE.macWatcher) {
  const probe = execaSync(
    "/bin/zsh",
    workerShellArguments(join(import.meta.dir, "../.."), [
      "/bin/zsh",
      "-f",
      "-c",
      WORKER_TOOL_PROBE,
    ]),
    {
      extendEnv: false,
      env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      reject: false,
      timeout: 20_000,
    },
  );
  if (probe.exitCode !== 0)
    findings.push({
      level: "required",
      label: "Merge queue environment",
      detail: probe.all || probe.stdout || probe.stderr || "login-shell tool probe failed",
    });
  for (const [repo, failure] of Object.entries(readMergeQueue().environment ?? {}))
    findings.push({
      level: failure.transient ? "optional" : "required",
      label: "Merge queue environment",
      detail: `${repo}: ${failure.cause}; retry after ${failure.retryAt}`,
    });

  const service = execaSync(
    "launchctl",
    ["print", `gui/${process.getuid?.()}/com.my-setup.merge-queue`],
    { reject: false },
  );
  if (service.exitCode !== 0)
    findings.push({
      level: "required",
      label: "Merge queue service",
      detail: "not loaded; run mise run install",
    });
  // launchd retains the previous exit code while a replacement pass is running.
  // A transient prepare timeout can leave a nonzero launchd exit code during backoff.
  else if (
    !/state = running\b/.test(service.stdout) &&
    /last exit code = [1-9]/.test(service.stdout) &&
    !Object.values(readMergeQueue().environment ?? {}).some((failure) => failure.transient)
  )
    findings.push({
      level: "required",
      label: "Merge queue worker",
      detail: "last pass failed; see ~/.local/state/merge-queue/worker.log",
    });
}

// Main Mac only. Checks that the session exists without reading or printing it.
if (PROFILE.name === "personal" && !remotePoolUrl) {
  const link = join(HOME, "bin/telegram-me");
  if (!existsSync(link) || readlinkSync(link) !== join(ROOT_DIR, "shell/telegram-me.zsh"))
    findings.push({
      level: "optional",
      label: "telegram-me",
      detail: "command not linked; run mise run install",
    });
  else if (!(await hasTelegramMeSession()))
    findings.push({
      level: "optional",
      label: "telegram-me",
      detail: "not signed in; run telegram-me login while the owner is at this Mac",
    });
}

if (findings.length === 0) {
  console.log("no local hygiene findings");
  process.exit(0);
}

for (const finding of findings)
  console.log(`${finding.level}\t${finding.label}: ${finding.detail}`);
process.exit(findings.some((finding) => finding.level === "required") ? 1 : 2);
