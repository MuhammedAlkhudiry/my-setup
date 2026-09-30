import { lstatSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { claudePoolPaths, prepareClaudePoolFiles, retireLegacyClaudeFiles } from "./claude-pool";

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

    if (process.platform !== "win32") {
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
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude Pool settings keep user keys and refresh the proxy credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "my-setup-claude-pool-test-"));
  try {
    const paths = claudePoolPaths(home);
    await mkdir(paths.claudeDir, { recursive: true });
    await writeFile(
      paths.claudeSettings,
      JSON.stringify({
        autoMemoryEnabled: false,
        hooks: { Stop: [] },
        env: { POOL_ONLY: "1", ANTHROPIC_API_KEY: "stale" },
      }),
    );

    await prepareClaudePoolFiles(home);
    await prepareClaudePoolFiles(home);

    const settings = JSON.parse(readFileSync(paths.claudeSettings, "utf8"));
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.hooks).toEqual({ Stop: [] });
    expect(settings.env).toMatchObject({ POOL_ONLY: "1", ANTHROPIC_API_KEY: "" });
    expect(settings.env.ANTHROPIC_BASE_URL).toStartWith("http://127.0.0.1:");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe(readFileSync(paths.clientKey, "utf8").trim());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Retiring the old Claude config removes only the files my-setup managed there", async () => {
  const home = await mkdtemp(join(tmpdir(), "my-setup-claude-pool-test-"));
  try {
    const paths = claudePoolPaths(home);
    const history = join(home, ".claude/projects/session.jsonl");
    await mkdir(join(home, ".claude/projects"), { recursive: true });
    await writeFile(paths.legacyClaudeRules, "old rules\n");
    await writeFile(history, "history\n");
    await writeFile(join(home, ".claude/settings.json"), "{}\n");
    await mkdir(join(home, ".agents/skills"), { recursive: true });
    await symlink(
      join(home, ".agents/skills"),
      paths.legacyClaudeSkills,
      process.platform === "win32" ? "junction" : undefined,
    );

    expect(await retireLegacyClaudeFiles(home)).toEqual([
      paths.legacyClaudeRules,
      paths.legacyClaudeSkills,
    ]);
    expect(lstatSync(paths.legacyClaudeRules, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(paths.legacyClaudeSkills, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(history, "utf8")).toBe("history\n");
    expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe("{}\n");
    expect(await retireLegacyClaudeFiles(home)).toEqual([]);

    await mkdir(join(paths.legacyClaudeSkills, "synced"), { recursive: true });
    expect(await retireLegacyClaudeFiles(home)).toEqual([]);
    expect(lstatSync(join(paths.legacyClaudeSkills, "synced")).isDirectory()).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
