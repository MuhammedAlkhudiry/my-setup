/**
 * MCP server definitions shared across supported environments.
 * Single source of truth for MCP entries used during config generation.
 */

interface McpServer {
  type: "local";
  command: [string, ...string[]];
  enabledTools: readonly string[];
  startupTimeoutSec: number;
  toolTimeoutSec: number;
}

export const MCP_SERVERS: Record<string, McpServer> = {
  maestro: {
    type: "local",
    command: ["maestro", "mcp"],
    enabledTools: [
      "list_devices",
      "inspect_screen",
      "run",
      "take_screenshot",
      "open_maestro_viewer",
    ],
    startupTimeoutSec: 10,
    toolTimeoutSec: 180,
  },
};

export function createOpencodeMcpConfig(): Record<
  string,
  {
    type: "local";
    command: [string, ...string[]];
    enabled: true;
    timeout: number;
  }
> {
  return Object.fromEntries(
    Object.entries(MCP_SERVERS).map(([name, server]) => [
      name,
      {
        type: server.type,
        command: server.command,
        enabled: true as const,
        timeout: server.toolTimeoutSec * 1_000,
      },
    ]),
  );
}

export function createOpencodeMcpToolConfig(): Record<string, boolean> {
  const tools: Record<string, boolean> = {};

  for (const [serverName, server] of Object.entries(MCP_SERVERS)) {
    const enabledTools = new Set(server.enabledTools);
    for (const toolName of [
      "list_devices",
      "take_screenshot",
      "run",
      "inspect_screen",
      "cheat_sheet",
      "open_maestro_viewer",
      "list_cloud_devices",
      "run_on_cloud",
      "get_cloud_run_status",
      "describe_cloud_run",
    ]) {
      if (!enabledTools.has(toolName)) {
        tools[`${serverName}_${toolName}`] = false;
      }
    }
  }

  return tools;
}
