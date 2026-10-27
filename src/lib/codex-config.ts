import { CODEX_CONFIG } from "../../config/codex";
import { MCP_SERVERS } from "../../config/mcp";

export function renderCodexMcpServersToml(servers = MCP_SERVERS): string {
  const lines = [
    "# Managed by my-setup. Do not edit by hand.",
    "# Source of truth: config/mcp.ts",
    "",
  ];
  for (const serverName of Object.keys(servers).sort()) {
    const server = servers[serverName];
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

// Codex offers its built-in image tool only to ChatGPT sign-ins, so a Mac on another Mac's pool draws through the
// image skill's script, which the owner approved once for every image here.
const REMOTE_POOL_IMAGE_INSTRUCTIONS =
  "Codex on this Mac signs in through another Mac's pool, so it has no built-in image tool. The owner has chosen the $imagegen CLI mode for all image work here: run its scripts/image_gen.py with `uv run --with openai --with pillow python` without asking. OPENAI_BASE_URL and OPENAI_API_KEY already point it at the pool.";

/** Top-level keys only a Mac on another Mac's pool sets; install removes them everywhere else. */
export const CODEX_REMOTE_POOL_TOP_LEVEL_KEYS = ["openai_base_url", "developer_instructions"];

/** Sends this Mac's Codex requests and image script to another Mac's pool with the copied client key. */
export function codexRemotePoolValues(
  poolUrl: string,
  clientKey: string,
): {
  topLevel: Array<[key: string, value: string]>;
  sections: Array<[section: string, key: string, value: string]>;
} {
  const apiUrl = JSON.stringify(`${poolUrl}/v1`);
  return {
    topLevel: [
      ["openai_base_url", apiUrl],
      ["developer_instructions", JSON.stringify(REMOTE_POOL_IMAGE_INSTRUCTIONS)],
    ],
    sections: [
      ["shell_environment_policy.set", "OPENAI_BASE_URL", apiUrl],
      ["shell_environment_policy.set", "OPENAI_API_KEY", JSON.stringify(clientKey)],
    ],
  };
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
