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

export const MCP_SERVERS: Record<string, McpServer> = {};

/**
 * Servers install removes from Claude Code, which keeps a server until it is removed by name. Codex and OpenCode drop them
 * on their own, because install rewrites their whole managed MCP section. Maestro's server started one JVM per session.
 */
export const RETIRED_MCP_SERVERS = ["maestro"];

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
