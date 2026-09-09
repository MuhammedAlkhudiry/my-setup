import { CODEX_CONFIG } from "../../config/codex";
import { MCP_SERVERS } from "../../config/mcp";

export function renderCodexMcpServersToml(): string {
  const lines = [
    "# Managed by my-setup. Do not edit by hand.",
    "# Source of truth: config/mcp.ts",
    "",
  ];
  for (const serverName of Object.keys(MCP_SERVERS).sort()) {
    const server = MCP_SERVERS[serverName];
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

export function codexManagedTopLevelValues(): Record<string, string> {
  return { model_verbosity: JSON.stringify(CODEX_CONFIG.model_verbosity) };
}

export function codexManagedSectionValues(): Array<[section: string, key: string, value: string]> {
  return [
    ["agents", "max_threads", String(CODEX_CONFIG.agents.max_threads)],
    [
      "features",
      "default_mode_request_user_input",
      String(CODEX_CONFIG.features.default_mode_request_user_input),
    ],
  ];
}
