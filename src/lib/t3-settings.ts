import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { T3_CLIENT_SETTINGS, T3_SERVER_SETTINGS, T3_THEME_ID } from "../../config/t3";

const THEME_SOURCE_PATH = join(import.meta.dir, "..", "..", "config", "t3-theme.json");

type JsonObject = Record<string, unknown>;

/** T3 Code keeps its state under `$T3CODE_HOME/userdata`, which defaults to `~/.t3/userdata` on every platform. */
export function t3StateDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.T3CODE_HOME?.trim() || join(home, ".t3"), "userdata");
}

export type T3SettingsInstallResult =
  | { installed: false }
  | { installed: true; stateDir: string; clientSettingsChanged: boolean; themeChanged: boolean };

export async function installT3Settings(options: {
  home: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): Promise<T3SettingsInstallResult> {
  const stateDir = t3StateDir(options.home, options.env);
  if (!existsSync(stateDir)) return { installed: false };

  const settingsPath = join(stateDir, "settings.json");
  const themePath = join(stateDir, "themes", `${T3_THEME_ID}.json`);
  const theme = await readFile(THEME_SOURCE_PATH, "utf-8");
  const settings = await readJsonObject(settingsPath);
  const themeChanged =
    settings.defaultTheme !== T3_THEME_ID ||
    !existsSync(themePath) ||
    (await readFile(themePath, "utf-8")) !== theme;

  // Each app applies a theme once per `defaultThemeSetAt`, so a new stamp only when the theme changes
  // keeps a theme picked later on one device until the managed theme itself changes.
  if (themeChanged) {
    await mkdir(join(stateDir, "themes"), { recursive: true });
    await writeFileAtomically(themePath, theme);
  }
  const themeSettings = themeChanged
    ? {
        defaultTheme: T3_THEME_ID,
        defaultThemeSetAt: (options.now ?? (() => new Date()))().toISOString(),
      }
    : {};
  await writeJsonIfChanged(
    settingsPath,
    settings,
    mergeManaged(settings, { ...T3_SERVER_SETTINGS, ...themeSettings }),
    2,
  );

  const clientSettingsPath = join(stateDir, "client-settings.json");
  const clientSettings = await readJsonObject(clientSettingsPath);
  const clientSettingsChanged = await writeJsonIfChanged(
    clientSettingsPath,
    clientSettings,
    mergeManaged(clientSettings, T3_CLIENT_SETTINGS),
  );

  return { installed: true, stateDir, clientSettingsChanged, themeChanged };
}

// Nested objects merge key by key, so unmanaged keys inside them, such as other cleanup options, survive.
export function mergeManaged(existing: JsonObject, managed: JsonObject): JsonObject {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(managed)) {
    const current = merged[key];
    merged[key] =
      isJsonObject(value) && isJsonObject(current) ? mergeManaged(current, value) : value;
  }
  return merged;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(path: string): Promise<JsonObject> {
  if (!existsSync(path)) return {};

  const value: unknown = JSON.parse(await readFile(path, "utf-8"));
  if (!isJsonObject(value)) throw new Error(`T3 Code settings must contain an object: ${path}`);
  return value;
}

// Returns whether the file was written; T3 keeps its own formatting, so the comparison ignores whitespace.
async function writeJsonIfChanged(
  path: string,
  existing: JsonObject,
  next: JsonObject,
  indent?: number,
): Promise<boolean> {
  if (JSON.stringify(existing) === JSON.stringify(next)) return false;

  await writeFileAtomically(path, `${JSON.stringify(next, null, indent)}\n`);
  return true;
}

// A running T3 watches these files, so it must never read a half-written one.
async function writeFileAtomically(path: string, contents: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.my-setup.tmp`;
  await writeFile(tempPath, contents);
  await rename(tempPath, path);
}
