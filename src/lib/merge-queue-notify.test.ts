import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { housekeeperNotifier, housekeeperThread, shorten } from "./merge-queue-notify";

const ROOT_DIR = join(import.meta.dir, "..", "..");
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("the notifier sends the message on stdin to the inbox's Housekeeper thread", async () => {
  const home = mkdtempSync(join(tmpdir(), "merge-queue-notify-"));
  directories.push(home);
  mkdirSync(join(home, ".t3/bin"), { recursive: true });
  const t3 = join(home, ".t3/bin/t3");
  writeFileSync(t3, `#!/bin/sh\nprintf '%s\\n' "$*" > "${home}/args"\ncat > "${home}/stdin"\n`);
  chmodSync(t3, 0o755);

  await housekeeperNotifier(ROOT_DIR, home)("merge-queue: owner/repo#1 failed");
  const thread = housekeeperThread(ROOT_DIR);
  expect(thread).toMatch(/^[0-9a-f-]{36}$/);
  expect(readFileSync(join(ROOT_DIR, "shell/t3-inbox.zsh"), "utf8")).toContain(
    "config/housekeeper-thread.txt",
  );
  expect(readFileSync(join(home, "args"), "utf8")).toBe(`thread send ${thread} -\n`);
  expect(readFileSync(join(home, "stdin"), "utf8")).toBe("merge-queue: owner/repo#1 failed");
});

test("shorten keeps both ends so a trailing log path survives", () => {
  expect(shorten("a\n  b")).toBe("a b");
  const long = `${"x".repeat(1000)}; /tmp/run.log`;
  const short = shorten(long, 100);
  expect(short.length).toBeLessThanOrEqual(100);
  expect(short).toEndWith("; /tmp/run.log");
});
