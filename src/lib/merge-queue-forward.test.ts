import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forwardedMergeQueueArgs,
  mainMacQueueCommand,
  processRequests,
  submitRequest,
} from "./merge-queue-forward";

test("spare Macs forward add with a thread and status", () => {
  const add = [
    "add",
    "MuhammedAlkhudiry/awraq-project",
    "766",
    "--thread",
    "mcp:be49a9b8-d7af-4696",
  ];
  expect(forwardedMergeQueueArgs(add)).toEqual(add);
  expect(forwardedMergeQueueArgs([...add, "--json"])).toEqual([...add, "--json"]);
  expect(forwardedMergeQueueArgs(["add", "owner/repo", "1", "--dry-run", "--thread", "t"])).toEqual(
    ["add", "owner/repo", "1", "--dry-run", "--thread", "t"],
  );
  expect(forwardedMergeQueueArgs(["status", "--json"])).toEqual(["status", "--json"]);
});

test("forwarding rejects other commands and unexpected arguments", () => {
  for (const args of [
    ["run"],
    ["remove", "owner/repo", "1"],
    ["retry-deploy", "owner/repo"],
    ["add", "owner/repo", "1"],
    ["add", "owner/repo", "0", "--thread", "t"],
    ["add", "owner/repo", "1", "--thread", "t;rm"],
    ["add", "owner/repo", "1", "--thread", "'t'"],
    ["add", "owner/repo", "1", "--thread", "t", "extra"],
    ["status", "extra"],
    [],
  ])
    expect(typeof forwardedMergeQueueArgs(args)).toBe("string");
});

test("spare Macs reach main-mac's queue through the inbox host", () => {
  expect(mainMacQueueCommand(["status"])).toEqual([
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "main-mac-inbox",
    "merge-queue",
    "status",
  ]);
});

test("a forwarded add runs in the GUI session and returns its output and exit code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "merge-queue-forward "));
  mkdirSync(join(directory, "requests"));
  const add = ["add", "owner/repo", "7", "--thread", "mcp:abc"];
  const calls: [string[], string][] = [];
  try {
    const pending = submitRequest(add, "big-mac", directory, 5_000);
    while (!readdirSync(join(directory, "requests")).some((name) => name.endsWith(".request.json")))
      await Bun.sleep(5);
    expect(
      await processRequests(directory, async (args, from) => {
        calls.push([args, from]);
        return { exitCode: 3, output: "merge-queue: queued" };
      }),
    ).toBe(1);
    expect(await pending).toEqual({ exitCode: 3, output: "merge-queue: queued" });
    expect(calls).toEqual([[add, "big-mac"]]);
    expect(readdirSync(join(directory, "requests"))).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("spooled requests other than a valid add from a named Mac are refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "merge-queue-forward "));
  mkdirSync(join(directory, "requests"));
  try {
    for (const [args, from] of [
      [["run"], "big-mac"],
      [["status"], "big-mac"],
      [["add", "owner/repo", "7", "--thread", "t"], "Big Mac"],
    ] as [string[], string][]) {
      const pending = submitRequest(args, from, directory, 5_000);
      while (
        !readdirSync(join(directory, "requests")).some((name) => name.endsWith(".request.json"))
      )
        await Bun.sleep(5);
      await processRequests(directory, async () => {
        throw new Error("must not run");
      });
      expect((await pending).exitCode).toBe(64);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
