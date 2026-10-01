import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "bun:test";

import { VSCODE_EXTENSIONS } from "../../config/vscode";
import { installVscodeKeymap, renderVscodeKeybindings, vscodeKeybindingsPath } from "./vscode";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "my-setup-vscode-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("resolves VS Code's user keybindings file per platform", () => {
  const userFile = ["Code", "User", "keybindings.json"];

  expect(vscodeKeybindingsPath("/home", "win32", { APPDATA: "/roaming" })).toBe(
    join("/roaming", ...userFile),
  );
  expect(vscodeKeybindingsPath("/home", "win32", {})).toBe(
    join("/home", "AppData", "Roaming", ...userFile),
  );
  expect(vscodeKeybindingsPath("/home", "darwin", {})).toBe(
    join("/home", "Library", "Application Support", ...userFile),
  );
});

test("renders keybindings VS Code can parse once the header comment is stripped", () => {
  const [header, ...json] = renderVscodeKeybindings().split("\n");

  expect(header).toStartWith("//");
  expect(JSON.parse(json.join("\n"))).toContainEqual({
    key: "ctrl+g",
    command: "-workbench.action.gotoLine",
  });
});

test("replaces existing keybindings and keeps the previous file as a backup", async () => {
  await withHome(async (home) => {
    const path = vscodeKeybindingsPath(home, "darwin", {});
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "[]\n");

    const result = await installVscodeKeymap({ home, platform: "darwin", env: {}, code: null });

    expect(readFileSync(path, "utf8")).toBe(renderVscodeKeybindings());
    expect(result.backupPath).toBe(`${path}.bak`);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe("[]\n");
    expect(result.extensionsInstalled).toBe(false);
  });
});

test("skips the backup when the installed keybindings are already current", async () => {
  await withHome(async (home) => {
    await installVscodeKeymap({ home, platform: "darwin", env: {}, code: null });
    const result = await installVscodeKeymap({ home, platform: "darwin", env: {}, code: null });

    expect(result.backupPath).toBeUndefined();
    expect(existsSync(`${result.keybindingsPath}.bak`)).toBe(false);
  });
});

// The fake `code` is a shell script, which Windows cannot run directly.
test.skipIf(process.platform === "win32")(
  "installs each extension through the code CLI",
  async () => {
    await withHome(async (home) => {
      const log = join(home, "code.log");
      const code = join(home, "code");
      writeFileSync(code, `#!/bin/sh\necho "$@" >> "${log}"\n`);
      chmodSync(code, 0o755);

      const result = await installVscodeKeymap({ home, platform: "darwin", env: {}, code });

      expect(result.extensionsInstalled).toBe(true);
      expect(readFileSync(log, "utf8")).toBe(
        VSCODE_EXTENSIONS.map((extension) => `--install-extension ${extension}\n`).join(""),
      );
    });
  },
);
