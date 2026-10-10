import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { T3_THEME_ID } from "../../config/t3";
import { installT3Settings, t3StateDir } from "./t3-settings";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "my-setup-t3-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("merges managed settings and keeps each device's own settings", async () => {
  await withHome(async (home) => {
    const stateDir = t3StateDir(home, {});
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        providers: { opencode: { enabled: false } },
        storageCleanup: { worktreeAfterDays: 3 },
      }),
    );
    writeFileSync(
      join(stateDir, "client-settings.json"),
      JSON.stringify({ favorites: [{ provider: "codex", model: "gpt" }], wordWrap: true }),
    );

    const result = await installT3Settings({ home, env: {} });

    const settings = readJson(join(stateDir, "settings.json"));
    expect(settings.providers).toEqual({ opencode: { enabled: false } });
    expect(settings.storageCleanup).toMatchObject({ worktreeAfterDays: 3, worktreeOnMerge: true });
    expect(settings.defaultTheme).toBe(T3_THEME_ID);
    expect(existsSync(join(stateDir, "themes", `${T3_THEME_ID}.json`))).toBe(true);
    const clientSettings = readJson(join(stateDir, "client-settings.json"));
    expect(clientSettings.favorites).toEqual([{ provider: "codex", model: "gpt" }]);
    expect(clientSettings.wordWrap).toBe(false);
    expect(result).toMatchObject({ clientSettingsChanged: true, themeChanged: true });
  });
});

test("re-applies the theme only when the managed theme changes", async () => {
  await withHome(async (home) => {
    const stateDir = t3StateDir(home, {});
    mkdirSync(stateDir, { recursive: true });
    const install = (iso: string) => installT3Settings({ home, env: {}, now: () => new Date(iso) });

    await install("2026-01-01T00:00:00.000Z");
    const rerun = await install("2026-01-02T00:00:00.000Z");
    expect(rerun).toMatchObject({ clientSettingsChanged: false, themeChanged: false });
    expect(readJson(join(stateDir, "settings.json")).defaultThemeSetAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );

    writeFileSync(join(stateDir, "themes", `${T3_THEME_ID}.json`), "{}");
    await install("2026-01-03T00:00:00.000Z");
    expect(readJson(join(stateDir, "settings.json")).defaultThemeSetAt).toBe(
      "2026-01-03T00:00:00.000Z",
    );
  });
});

test("skips devices without T3 Code", async () => {
  await withHome(async (home) => {
    expect(await installT3Settings({ home, env: {} })).toEqual({ installed: false });
    expect(existsSync(t3StateDir(home, {}))).toBe(false);
  });
});
