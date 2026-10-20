import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import { timedCommand } from "./timed-command";

async function expectGone(pids: number[]) {
  const result = await execa("ps", ["-o", "stat=", "-p", pids.join(",")], { reject: false });
  expect(
    result.stdout.split("\n").filter((state) => state.trim() && !state.trim().startsWith("Z")),
  ).toEqual([]);
}

test("timeout closes inherited pipes and kills the entire command group", async () => {
  let expire!: () => void;
  const ready = () => expire();
  process.once("SIGUSR2", ready);
  const result = await timedCommand(
    "sh",
    ["-c", 'sleep 30 & echo "$$ $!"; kill -USR2 "$PPID"; wait'],
    {
      timeout: 90_000,
      scheduleDeadline: (callback, milliseconds) => {
        expect(milliseconds).toBe(90_000);
        expire = callback;
        return () => process.removeListener("SIGUSR2", ready);
      },
    },
  );

  expect(result.timedOut).toBe(true);
  expect(result.failed).toBe(true);
  expect(result.exitCode).toBe(124);
  await expectGone(result.stdout.trim().split(/\s+/).map(Number));
}, 3_000);

for (const signal of ["SIGTERM", "SIGUSR1"] as const) {
  test(`${signal === "SIGTERM" ? "guard termination" : "parent exit"} kills active detached command groups`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "timed-command-test-"));
    const marker = join(directory, "pids");
    const helper = new URL("./timed-command.ts", import.meta.url).href;
    const script = `
      import { timedCommand } from ${JSON.stringify(helper)};
      const kill = process.kill.bind(process);
      const killed = new Set();
      process.kill = (pid, signal) => {
        if (pid < 0) {
          if (killed.has(pid)) throw new Error("Command group killed twice during termination and exit");
          killed.add(pid);
        }
        return kill(pid, signal);
      };
      process.on("SIGUSR1", () => process.exit(0));
      await timedCommand("sh", ["-c", 'sleep 30 & echo "$$ $!" > "$1"; kill -${signal.slice(3)} "$PPID"; wait', "sh", ${JSON.stringify(marker)}], { timeout: 10_000 });
    `;

    try {
      const result = await execa(process.execPath, ["--eval", script], {
        reject: false,
        timeout: 2_000,
      });
      expect(result.timedOut).toBe(false);
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: signal === "SIGTERM" ? 143 : 0,
        stderr: "",
      });
      await expectGone((await readFile(marker, "utf8")).trim().split(/\s+/).map(Number));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 3_000);
}

test("commands finishing before the deadline retain their own exit code", async () => {
  for (const exitCode of [0, 42]) {
    const result = await timedCommand("sh", ["-c", `exit ${exitCode}`], {
      timeout: 90_000,
      scheduleDeadline: () => () => {},
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(exitCode);
  }
});
