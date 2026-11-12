/**
 * MCP server definitions shared across supported environments.
 * Single source of truth for MCP entries used during config generation.
 */

interface LocalMcpServer {
  type: "local";
  command: [string, ...string[]];
  enabledTools: readonly string[];
  startupTimeoutSec: number;
  toolTimeoutSec: number;
}

interface HttpMcpServer {
  type: "http";
  url: string;
}

export type McpServer = LocalMcpServer | HttpMcpServer;

export const MCP_SERVERS: Record<string, LocalMcpServer> = {};

export const WORK_MCP_SERVERS: Record<string, McpServer> = {
  atlassian: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" },
};

type OpencodeMcpServer =
  | { type: "local"; command: [string, ...string[]]; enabled: true; timeout: number }
  | { type: "remote"; url: string; enabled: true };

export function createOpencodeMcpConfig(
  servers: Record<string, McpServer>,
): Record<string, OpencodeMcpServer> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]): [string, OpencodeMcpServer] => [
      name,
      server.type === "http"
        ? { type: "remote", url: server.url, enabled: true }
        : {
            type: "local",
            command: server.command,
            enabled: true,
            timeout: server.toolTimeoutSec * 1_000,
          },
    ]),
  );
}
