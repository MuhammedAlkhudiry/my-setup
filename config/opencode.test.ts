import { expect, test } from "bun:test";
import { DEVICE_PROFILES } from "./devices";
import { mergeOpencodeConfig } from "./opencode";

test("V2 installation preserves provider models and local MCP configuration across syncs", () => {
  const existing = {
    provider: { custom: { models: { example: { name: "My model" } } } },
    mcp: { local: { type: "local", command: ["my-server"] } },
    keybinds: { model_cycle_favorite: "ctrl+a" },
    tools: { custom: false },
  };
  const merged = mergeOpencodeConfig(existing, DEVICE_PROFILES.personal, "/Users/example");

  expect(merged.provider).toEqual(existing.provider);
  expect(merged.mcp).toMatchObject(existing.mcp);
  expect(merged.tools).toMatchObject(existing.tools);
  expect(merged).not.toHaveProperty("keybinds");
  expect(mergeOpencodeConfig(merged, DEVICE_PROFILES.personal, "/Users/example")).toEqual(merged);
});
