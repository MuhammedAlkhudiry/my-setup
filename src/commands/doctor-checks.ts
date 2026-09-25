#!/usr/bin/env bun

/**
 * Local hygiene checks used by `doctor`. Prints one `<level>\t<label>: <detail>` line per finding.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execaSync } from "execa";

import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { mergeRtkHooks } from "../../config/rtk";
import { renderBaseRules } from "./install";

const ROOT_DIR = join(import.meta.dir, "..", "..");
const HOME = process.env.HOME || "";

const INSTALLED_RULES_FILES = [
  { label: "Claude Code", path: join(HOME, ".claude/CLAUDE.md") },
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
  ["claude", join(HOME, ".claude/settings.json")],
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

if (findings.length === 0) {
  console.log("no local hygiene findings");
  process.exit(0);
}

for (const finding of findings)
  console.log(`${finding.level}\t${finding.label}: ${finding.detail}`);
process.exit(findings.some((finding) => finding.level === "required") ? 1 : 2);
