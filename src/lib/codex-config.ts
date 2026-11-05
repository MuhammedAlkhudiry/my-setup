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

// Spare Macs once sent Codex through another Mac's pool; Codex now signs in to ChatGPT on every Mac for its built-in
// image tool (owner, 2026-11-04), so install removes the pool keys wherever they remain.
export const CODEX_RETIRED_POOL_TOP_LEVEL_KEYS = ["openai_base_url", "developer_instructions"];
export const CODEX_RETIRED_POOL_SECTION_KEYS: Array<[section: string, key: string]> = [
  ["shell_environment_policy.set", "OPENAI_BASE_URL"],
  ["shell_environment_policy.set", "OPENAI_API_KEY"],
];

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
