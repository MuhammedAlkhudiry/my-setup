import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keeperThread, queueNotifier, shorten } from "./merge-queue-notify";

const ROOT_DIR = join(import.meta.dir, "..", "..");
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A setup root holding only config/keeper-threads.json. */
function rootWith(threads: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "keeper-threads-"));
  directories.push(root);
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/keeper-threads.json"), JSON.stringify(threads));
  return root;
}

test("a keeper without a thread falls back to the Housekeeper front desk", () => {
  const root = rootWith({ housekeeper: "front-desk", ops: "ops-thread", business: "" });
  expect(keeperThread(root, "ops")).toBe("ops-thread");
  expect(keeperThread(root, "business")).toBe("front-desk");
  expect(() => keeperThread(rootWith({ ops: "ops-thread" }), "ops")).toThrow(
    "no housekeeper thread",
  );
});

test("the repository's keeper threads name the front desk the spare-Mac inbox reads", () => {
  expect(keeperThread(ROOT_DIR, "housekeeper")).toMatch(/^[0-9a-f-]{36}$/);
  expect(readFileSync(join(ROOT_DIR, "shell/t3-inbox.zsh"), "utf8")).toContain(
    "config/keeper-threads.json",
  );
});

test.skipIf(process.platform === "win32")(
  "the notifier sends batch events on stdin to the Ops keeper",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "merge-queue-notify-"));
    directories.push(home);
    mkdirSync(join(home, ".t3/bin"), { recursive: true });
    const t3 = join(home, ".t3/bin/t3");
    writeFileSync(t3, `#!/bin/sh\nprintf '%s\\n' "$*" > "${home}/args"\ncat > "${home}/stdin"\n`);
    chmodSync(t3, 0o755);

    await queueNotifier(
      rootWith({ housekeeper: "front-desk", ops: "ops-thread" }),
      home,
    )("merge-queue: owner/repo#1 failed");
    expect(readFileSync(join(home, "args"), "utf8")).toBe("thread send ops-thread -\n");
    expect(readFileSync(join(home, "stdin"), "utf8")).toBe("merge-queue: owner/repo#1 failed");
  },
);

test.skipIf(process.platform === "win32")(
  "a PR's message goes to its owning thread, not the Ops keeper",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "merge-queue-notify-"));
    directories.push(home);
    mkdirSync(join(home, ".t3/bin"), { recursive: true });
    const t3 = join(home, ".t3/bin/t3");
    writeFileSync(t3, `#!/bin/sh\nprintf '%s\\n' "$*" > "${home}/args"\ncat > "${home}/stdin"\n`);
    chmodSync(t3, 0o755);

    await queueNotifier(ROOT_DIR, home)("merge-queue: owner/repo#1 failed", {
      thread: "owner-thread",
    });
    expect(readFileSync(join(home, "args"), "utf8")).toBe("thread send owner-thread -\n");
    expect(readFileSync(join(home, "stdin"), "utf8")).toBe("merge-queue: owner/repo#1 failed");
  },
);

test.skipIf(process.platform === "win32")(
  "an unreachable owner falls back to the Ops keeper with the reason",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "merge-queue-notify-"));
    directories.push(home);
    mkdirSync(join(home, ".t3/bin"), { recursive: true });
    const t3 = join(home, ".t3/bin/t3");
    writeFileSync(
      t3,
      `#!/bin/sh\nif [ "$3" = "gone-thread" ]; then echo "thread not found" >&2; exit 1; fi\nprintf '%s\\n' "$*" > "${home}/args"\ncat > "${home}/stdin"\n`,
    );
    chmodSync(t3, 0o755);

    await queueNotifier(rootWith({ housekeeper: "front-desk", ops: "ops-thread" }), home)(
      "merge-queue: owner/repo#1 failed",
      {
        thread: "gone-thread",
      },
    );
    expect(readFileSync(join(home, "args"), "utf8")).toBe("thread send ops-thread -\n");
    expect(readFileSync(join(home, "stdin"), "utf8")).toContain(
      "Not delivered to owning thread gone-thread on main-mac",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "an owner id missing its mcp: prefix is retried with the id t3 suggests",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "merge-queue-notify-"));
    directories.push(home);
    mkdirSync(join(home, ".t3/bin"), { recursive: true });
    const t3 = join(home, ".t3/bin/t3");
    writeFileSync(
      t3,
      `#!/bin/sh\nif [ "$3" = "owner-thread" ]; then echo "Thread owner-thread was not found. Did you mean \\\`mcp:owner-thread\\\`?" >&2; exit 1; fi\nprintf '%s\\n' "$*" > "${home}/args"\ncat > "${home}/stdin"\n`,
    );
    chmodSync(t3, 0o755);

    await queueNotifier(rootWith({ housekeeper: "front-desk", ops: "ops-thread" }), home)(
      "merge-queue: owner/repo#1 merged",
      { thread: "owner-thread" },
    );
    expect(readFileSync(join(home, "args"), "utf8")).toBe("thread send mcp:owner-thread -\n");
    expect(readFileSync(join(home, "stdin"), "utf8")).toBe("merge-queue: owner/repo#1 merged");
  },
);

test("shorten keeps both ends so a trailing log path survives", () => {
  expect(shorten("a\n  b")).toBe("a b");
  const long = `${"x".repeat(1000)}; /tmp/run.log`;
  const short = shorten(long, 100);
  expect(short.length).toBeLessThanOrEqual(100);
  expect(short).toEndWith("; /tmp/run.log");
});
