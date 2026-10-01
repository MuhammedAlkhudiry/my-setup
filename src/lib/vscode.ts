import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { execa } from "execa";

import {
  VSCODE_EXTENSIONS,
  VSCODE_KEYBINDINGS,
  VSCODE_SETTINGS,
  type VscodeKeybinding,
} from "../../config/vscode";
import { ensureParentDir } from "./fs";

const HEADER =
  "// Managed by my-setup (config/vscode.ts). mise run install replaces this file; edit the repo instead.";

/** VS Code's user `keybindings.json` for the given platform. */
export function vscodeKeybindingsPath(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return join(
      env.APPDATA || join(home, "AppData", "Roaming"),
      "Code",
      "User",
      "keybindings.json",
    );
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "keybindings.json");
  }

  return join(home, ".config", "Code", "User", "keybindings.json");
}

export function renderVscodeKeybindings(
  keybindings: readonly VscodeKeybinding[] = VSCODE_KEYBINDINGS,
): string {
  return `${HEADER}\n${JSON.stringify(keybindings, null, 2)}\n`;
}

export type VscodeKeymapInstallResult = {
  keybindingsPath: string;
  // Set when an existing file with other contents was saved before it was replaced.
  backupPath?: string;
  // False when the `code` CLI is not on PATH, so the extensions were skipped.
  extensionsInstalled: boolean;
};

export async function installVscodeKeymap(options: {
  home: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  code?: string | null;
}): Promise<VscodeKeymapInstallResult> {
  const keybindingsPath = vscodeKeybindingsPath(options.home, options.platform, options.env);
  const rendered = renderVscodeKeybindings();

  const settingsPath = join(dirname(keybindingsPath), "settings.json");
  const existingSettings: unknown = existsSync(settingsPath)
    ? Bun.JSON5.parse(await readFile(settingsPath, "utf-8"))
    : {};

  if (
    !existingSettings ||
    typeof existingSettings !== "object" ||
    Array.isArray(existingSettings)
  ) {
    throw new Error(`VS Code settings must contain an object: ${settingsPath}`);
  }

  await ensureParentDir(settingsPath);
  await writeFile(
    settingsPath,
    JSON.stringify({ ...existingSettings, ...VSCODE_SETTINGS }, null, 2) + "\n",
  );

  // Keep the replaced contents, such as shortcuts added in VS Code's UI, so a reinstall never loses them silently.
  let backupPath: string | undefined;
  if (existsSync(keybindingsPath) && (await readFile(keybindingsPath, "utf-8")) !== rendered) {
    backupPath = `${keybindingsPath}.bak`;
    await copyFile(keybindingsPath, backupPath);
  }

  await ensureParentDir(keybindingsPath);
  await writeFile(keybindingsPath, rendered);

  // On Windows `code` is a `code.cmd` shim; execa runs it through cmd.exe.
  const code = options.code === undefined ? Bun.which("code") : options.code;
  if (code) {
    for (const extension of VSCODE_EXTENSIONS) {
      await execa(code, ["--install-extension", extension], { stdio: "pipe" });
    }
  }

  return { keybindingsPath, backupPath, extensionsInstalled: Boolean(code) };
}
