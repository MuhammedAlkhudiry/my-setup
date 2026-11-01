import { describe, expect, test } from "bun:test";

import { DEVICE_PROFILES } from "../../config/devices";
import { renderCodexMcpServersToml } from "./codex-config";

describe("renderCodexMcpServersToml", () => {
  test("renders a remote server with its url and no local command keys", () => {
    const rendered = renderCodexMcpServersToml({
      remote: { type: "http", url: "https://example.com/mcp" },
    });

    expect(rendered).toContain('[mcp_servers.remote]\nurl = "https://example.com/mcp"\n');
    expect(rendered).not.toContain("command =");
  });

  test("renders a local server with its command and limits", () => {
    const rendered = renderCodexMcpServersToml({
      local: {
        type: "local",
        command: ["tool", "serve"],
        enabledTools: ["read"],
        startupTimeoutSec: 5,
        toolTimeoutSec: 10,
      },
    });

    expect(rendered).toContain('command = "tool"\nargs = ["serve"]');
    expect(rendered).toContain('enabled_tools = ["read"]');
  });

  test("installs Atlassian only on the work profile", () => {
    expect(renderCodexMcpServersToml(DEVICE_PROFILES.work.mcpServers)).toContain(
      "[mcp_servers.atlassian]",
    );
    expect(renderCodexMcpServersToml(DEVICE_PROFILES.personal.mcpServers)).not.toContain(
      "atlassian",
    );
  });
});
