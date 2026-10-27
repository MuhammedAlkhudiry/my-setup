import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { workerShellArguments } from "./merge-queue-environment";

test("worker explicitly loads managed environment and preserves paths containing spaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker environment "));
  mkdirSync(join(root, "shell"));
  const bin = join(root, "Herd bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "php"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(
    join(root, "shell/zsh-custom.zsh"),
    `export PATH='${bin}':$PATH\nexport HERD_PHP_85_INI_SCAN_DIR='${root}/php config'\n`,
  );
  try {
    const result = await execa(
      "/bin/zsh",
      workerShellArguments(root, [
        "/bin/zsh",
        "-f",
        "-c",
        'command -v php; print -r -- "$HERD_PHP_85_INI_SCAN_DIR"',
      ]),
      { extendEnv: false, env: { HOME: root, PATH: "/usr/bin:/bin" } },
    );
    expect(result.stdout.split("\n")).toEqual([
      join(bin, "php"),
      join(root, "php config"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
