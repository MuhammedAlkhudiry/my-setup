import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const guard = new URL("../../shell/mirror-spare-copy.zsh", import.meta.url).pathname;

function spareMac(inbox = "cat") {
  const home = mkdtempSync(join(tmpdir(), "mirror-spare-copy-"));
  const copy = join(home, "PhpstormProjects/my-setup");
  const write = (path: string, content: string) => {
    mkdirSync(join(copy, path, ".."), { recursive: true });
    writeFileSync(join(copy, path), content);
  };
  write(".gitignore", "node_modules\n");
  write("config/device-pool.ts", "export const size = 2;\n");
  write("shell/old.zsh", "print old\n");
  write("node_modules/pkg/index.js", "1\n");
  write(".claude/scheduled_tasks.lock", "a\n");
  const inboxFile = join(home, "inbox.txt");
  const inboxCommand = join(home, "inbox.zsh");
  writeFileSync(inboxCommand, `#!/bin/zsh\n${inbox} >${inboxFile}\n`, { mode: 0o755 });
  const run = (action: string) => {
    const result = spawnSync("zsh", ["-s", "--", action, "PhpstormProjects/my-setup"], {
      input: readFileSync(guard),
      env: { PATH: process.env.PATH, HOME: home, MIRROR_INBOX_COMMAND: inboxCommand },
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    return result.stdout.trim();
  };
  const patches = () => {
    const directory = join(home, ".local/state/my-setup/mirror-edits");

    return existsSync(directory) ? readdirSync(directory).map((name) => join(directory, name)) : [];
  };

  const remove = () => {
    spawnSync("chmod", ["-R", "u+w", home]);
    rmSync(home, { recursive: true, force: true });
  };

  return { home, copy, write, run, patches, inboxFile, remove };
}

test("a spare Mac with no recorded mirror, or only dependency and agent runtime changes, reports nothing", () => {
  const spare = spareMac();
  try {
    expect(spare.run("unlock")).toBe("");
    spare.run("lock");
    spare.write("node_modules/pkg/index.js", "2\n");
    spare.write(".claude/scheduled_tasks.lock", "b\n");
    expect(spare.run("unlock")).toBe("");
    expect(spare.patches()).toEqual([]);
    expect(existsSync(spare.inboxFile)).toBe(false);
  } finally {
    spare.remove();
  }
});

test("local edits since the last mirror are saved as an applicable patch and sent to the Housekeeper", () => {
  const spare = spareMac();
  try {
    spare.run("lock");
    spare.run("unlock");
    const pristine = join(spare.home, "pristine");
    cpSync(spare.copy, pristine, { recursive: true });
    spare.write("config/device-pool.ts", "export const size = 3;\n");
    spare.write("config/new.ts", "export {};\n");
    rmSync(join(spare.copy, "shell/old.zsh"));

    const line = spare.run("unlock");
    const [patch] = spare.patches();
    expect(line).toBe(
      `3 local edits saved to ${patch} before the mirror overwrote them: config/device-pool.ts, config/new.ts, shell/old.zsh`,
    );
    const inbox = readFileSync(spare.inboxFile, "utf8");
    expect(inbox).toContain("overwrote local edits on");
    expect(inbox).toContain(`Saved patch on `);
    expect(inbox).toContain(patch);

    const applied = spawnSync("git", ["apply", patch], { cwd: pristine, encoding: "utf8" });
    expect(applied.stderr).toBe("");
    expect(readFileSync(join(pristine, "config/device-pool.ts"), "utf8")).toBe(
      "export const size = 3;\n",
    );
    expect(existsSync(join(pristine, "config/new.ts"))).toBe(true);
    expect(existsSync(join(pristine, "shell/old.zsh"))).toBe(false);

    spare.run("lock");
    expect(spare.run("unlock")).toBe("");
  } finally {
    spare.remove();
  }
});

test("a failed inbox still saves the patch and says the Housekeeper was not told", () => {
  const spare = spareMac("false");
  try {
    spare.run("lock");
    spare.run("unlock");
    spare.write("config/device-pool.ts", "export const size = 4;\n");

    expect(spare.run("unlock")).toEndWith("; the Housekeeper inbox failed");
    expect(spare.patches()).toHaveLength(1);
  } finally {
    spare.remove();
  }
});

test("lock leaves the copy non-writable except dependencies and agent runtime state, and unlock restores it", () => {
  const spare = spareMac();
  try {
    spare.run("lock");
    const writable = (path: string) => (statSync(join(spare.copy, path)).mode & 0o222) !== 0;

    expect(writable("config/device-pool.ts")).toBe(false);
    expect(writable("config")).toBe(false);
    expect(writable(".")).toBe(false);
    expect(() => writeFileSync(join(spare.copy, "config/device-pool.ts"), "x")).toThrow("EACCES");
    expect(() => writeFileSync(join(spare.copy, "config/new.ts"), "x")).toThrow("EACCES");
    expect(writable("node_modules/pkg/index.js")).toBe(true);
    expect(writable(".claude/scheduled_tasks.lock")).toBe(true);

    expect(spare.run("unlock")).toBe("");
    expect(writable("config/device-pool.ts")).toBe(true);
    expect(writable(".")).toBe(true);
  } finally {
    spare.remove();
  }
});
