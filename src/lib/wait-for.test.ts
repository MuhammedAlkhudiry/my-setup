import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCondition, waitFor } from "./wait-for";

const fast = { timeoutSeconds: 2, intervalSeconds: 0.05 };
const cli = new URL("../commands/wait-for-cli.ts", import.meta.url).pathname;

test("conditions parse their targets and reject malformed ones", () => {
  expect(parseCondition(["port", "3000"])).toEqual({ kind: "port", target: "3000" });
  expect(parseCondition(["cmd", "test -f x"]).argv).toEqual(["/bin/sh", "-c", "test -f x"]);
  expect(parseCondition(["cmd", "test", "-f", "x"]).argv).toEqual(["test", "-f", "x"]);
  for (const args of [[], ["socket", "x"], ["pid", "abc"], ["url", "localhost"], ["file"], ["file", "a", "b"]])
    expect(() => parseCondition(args)).toThrow();
});

test("a file condition waits for the file to appear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wait-for-test-"));
  try {
    const path = join(dir, "done");
    setTimeout(() => writeFileSync(path, ""), 150);
    const result = await waitFor({ kind: "file", target: path }, fast);
    expect(result.status).toBe("met");
    expect(result.attempts).toBeGreaterThan(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("port, pid, and cmd conditions report met or time out with the last attempt", async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  expect((await waitFor({ kind: "port", target: String(port) }, fast)).status).toBe("met");
  server.close();

  const child = Bun.spawn(["sleep", "0.2"]);
  expect((await waitFor({ kind: "pid", target: String(child.pid) }, fast)).status).toBe("met");

  const failing = await waitFor(parseCondition(["cmd", "echo nope; exit 3"]), { timeoutSeconds: 0.3, intervalSeconds: 0.1 });
  expect(failing).toMatchObject({ status: "timed-out", last: "exit 3\nnope" });
});

test("the command prints one line and carries the outcome in its exit code", async () => {
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  };

  const met = await run("cmd", "true");
  expect(met).toMatchObject({ code: 0, err: "" });
  expect(met.out).toStartWith("wait-for: cmd true ready after");

  const timedOut = await run("--timeout", "0.3", "--interval", "0.1", "cmd", "echo a; echo b; exit 1");
  expect(timedOut.code).toBe(75);
  expect(timedOut.err).toContain("last attempt log:");

  const json = JSON.parse((await run("--json", "--timeout", "0.2", "file", "/nonexistent/wait-for")).out);
  expect(json).toMatchObject({ condition: "file", status: "timed-out", last: "missing" });

  expect((await run("--timeout", "x", "file", "/tmp")).code).toBe(2);
});
