import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { claudePoolPaths, prepareClaudePoolFiles } from "./claude-pool";

test("Claude Pool installation preserves local keys and OAuth files on repeat runs", async () => {
  const home = await mkdtemp(join(tmpdir(), "my-setup-claude-pool-test-"));
  try {
    const paths = claudePoolPaths(home);
    expect((await prepareClaudePoolFiles(home)).plistChanged).toBe(true);
    const original = {
      clientKey: readFileSync(paths.clientKey, "utf8"),
      managementKey: readFileSync(paths.managementKey, "utf8"),
      config: readFileSync(paths.config, "utf8"),
      settings: readFileSync(paths.claudeSettings, "utf8"),
    };
    const oauthFile = join(paths.authDir, "claude-existing.json");
    await writeFile(oauthFile, "existing OAuth credential\n", { mode: 0o600 });

    expect((await prepareClaudePoolFiles(home)).plistChanged).toBe(false);
    expect(readFileSync(paths.clientKey, "utf8")).toBe(original.clientKey);
    expect(readFileSync(paths.managementKey, "utf8")).toBe(original.managementKey);
    expect(readFileSync(paths.config, "utf8")).toBe(original.config);
    expect(readFileSync(paths.claudeSettings, "utf8")).toBe(original.settings);
    expect(readFileSync(oauthFile, "utf8")).toBe("existing OAuth credential\n");
    expect(original.config).toContain('host: "127.0.0.1"');
    expect(original.config).toContain("allow-remote: false");
    expect(original.config).toContain("disable-control-panel: false");
    expect(original.config).toContain("session-affinity-subagents: false");

    for (const file of [
      paths.config,
      paths.clientKey,
      paths.managementKey,
      paths.claudeSettings,
      paths.launchAgent,
    ]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    for (const dir of [join(home, ".cli-proxy-api"), paths.authDir, paths.claudeDir]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
