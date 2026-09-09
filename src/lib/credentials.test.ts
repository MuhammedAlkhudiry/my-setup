import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "bun:test";

import { CREDENTIALS_ROOT } from "../../config/credentials";
import { secureManagedCredentials } from "./credentials";

test("creates a private credentials root without creating credential files", async () => {
  const home = await mkdtemp(join(tmpdir(), "my-setup-credentials-"));
  try {
    await secureManagedCredentials(home);
    const root = join(home, CREDENTIALS_ROOT);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(existsSync(join(root, "secrets.zsh"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("restricts existing credentials and parent directories without changing contents", async () => {
  const home = await mkdtemp(join(tmpdir(), "my-setup-credentials-"));
  try {
    const root = join(home, CREDENTIALS_ROOT);
    const path = join(root, "environments/awraq/mobile-release.env");
    const contents = 'export ASC_KEY_PATH="custom-key-path"\n';
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    writeFileSync(path, contents, { mode: 0o644 });

    await secureManagedCredentials(home);
    await secureManagedCredentials(home);

    for (const directory of [root, join(root, "environments"), dirname(path)]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(contents);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
