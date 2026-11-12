import { CODEX_CONFIG } from "../../config/codex";
import type { McpServer } from "../../config/mcp";

export function renderCodexMcpServersToml(servers: Record<string, McpServer>): string {
  const lines = [
    "# Managed by my-setup. Do not edit by hand.",
    "# Source of truth: config/mcp.ts",
    "",
  ];
  for (const serverName of Object.keys(servers).sort()) {
    const server = servers[serverName];
    if (server.type === "http") {
      lines.push(`[mcp_servers.${serverName}]`, `url = ${JSON.stringify(server.url)}`, "");
      continue;
    }
    const [command, ...args] = server.command;
    lines.push(
      `[mcp_servers.${serverName}]`,
      `command = ${JSON.stringify(command)}`,
      `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      `startup_timeout_sec = ${server.startupTimeoutSec}`,
      `tool_timeout_sec = ${server.toolTimeoutSec}`,
      `enabled_tools = [${server.enabledTools.map((tool) => JSON.stringify(tool)).join(", ")}]`,
      "",
    );
  }
  return lines.join("\n");
}

export function codexManagedTopLevelValues(): Array<[key: string, value: string]> {
  return [["model_reasoning_effort", JSON.stringify(CODEX_CONFIG.model_reasoning_effort)]];
}

export function codexManagedSectionValues(): Array<[section: string, key: string, value: string]> {
  return [
    ["agents", "max_threads", String(CODEX_CONFIG.agents.max_threads)],
    ...Object.entries(CODEX_CONFIG.features).map(([key, value]): [string, string, string] => [
      "features",
      key,
      String(value),
    ]),
  ];
}
