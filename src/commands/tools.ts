import { execa } from "execa";

import { SYSTEM_TOOL_GROUPS, type SystemTool } from "../lib/system-tools";

interface ToolStatus {
  tool: SystemTool;
  path?: string;
  current?: string;
  latest?: string;
  versionError?: string;
}

interface HomebrewInfo {
  formulae?: {
    versions?: {
      stable?: string;
    };
  }[];
}

async function commandOutput(
  command: string,
  args: string[],
  timeout = 5_000,
): Promise<string | undefined> {
  try {
    const result = await execa(command, args, {
      env: process.env,
      timeout,
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

async function homebrewLatest(formula: string): Promise<string | undefined> {
  try {
    const result = await execa("brew", ["info", "--json=v2", formula], {
      env: process.env,
      timeout: 60_000,
    });
    const info = JSON.parse(result.stdout) as HomebrewInfo;
    return info.formulae?.[0]?.versions?.stable;
  } catch {
    return undefined;
  }
}

async function latestVersion(tool: SystemTool): Promise<string | undefined> {
  if (!tool.latest) {
    return undefined;
  }

  if (tool.latest.type === "homebrew") {
    return homebrewLatest(tool.latest.formula);
  }

  return commandOutput(tool.latest.command, [...tool.latest.args], 30_000);
}

async function toolStatus(tool: SystemTool): Promise<ToolStatus> {
  const [path, latest] = await Promise.all([
    commandOutput("zsh", ["-lc", `command -v ${tool.name}`]),
    latestVersion(tool),
  ]);
  if (!path) {
    return { tool, latest };
  }

  if (!tool.versionArgs) {
    return { tool, path, latest };
  }

  const current = await commandOutput(tool.name, [...tool.versionArgs]);
  if (current) {
    return { tool, path, current, latest };
  }

  return { tool, path, latest, versionError: "version unavailable" };
}

function statusLabel(status: ToolStatus): string {
  if (!status.path) {
    return status.tool.level;
  }
  if (!status.latest) {
    return "unknown";
  }
  if (normalizedVersion(status.current) === normalizedVersion(status.latest)) {
    return "current";
  }
  return "update";
}

function normalizedVersion(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? value.trim();
}

function currentText(status: ToolStatus): string {
  if (status.current) {
    return status.current;
  }
  if (status.versionError) {
    return status.versionError;
  }
  if (status.path) {
    return "installed";
  }
  return "missing";
}

export async function toolsStatus(): Promise<void> {
  for (const group of SYSTEM_TOOL_GROUPS) {
    console.log(`\n## ${group.title}`);
    const statuses = await Promise.all(group.tools.map(toolStatus));

    for (const status of statuses) {
      const location = status.path ? ` ${status.path}` : "";
      console.log(
        `[${statusLabel(status)}] ${status.tool.name.padEnd(13)} current: ${currentText(status)} | latest: ${status.latest || "unknown"}${location}`,
      );
    }
  }
}

export async function toolsUpdatePlan(): Promise<void> {
  console.log("Tool update plan");
  console.log("Review these commands before running them. They are grouped by install owner.");

  for (const group of SYSTEM_TOOL_GROUPS) {
    console.log(`\n## ${group.title}`);
    const statuses = await Promise.all(group.tools.map(toolStatus));

    for (const status of statuses) {
      console.log(`\n${status.tool.name}`);
      console.log(`  status: ${statusLabel(status)}`);
      console.log(`  current: ${currentText(status)}`);
      console.log(`  latest: ${status.latest || "unknown"}`);
      if (status.path) {
        console.log(`  path: ${status.path}`);
      }

      if (status.tool.update.commands) {
        console.log("  update:");
        for (const command of status.tool.update.commands) {
          console.log(`    ${command}`);
        }
      }

      if (status.tool.update.note) {
        console.log(`  note: ${status.tool.update.note}`);
      }
    }
  }
}
