import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./device-queue-cli.ts", import.meta.url).pathname;

test("device queue prints compact success, structured status, verbose detail, and only a logged boot failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-output-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const xcrun = `#!${process.execPath}
    import { existsSync } from "node:fs";
    const a = process.argv.slice(2);
    if (a[1] === "list") console.log(JSON.stringify({devices:{runtime:[{udid:"test-device",name:"Test simulator",state:"Shutdown"}]}}));
    else if (a[1] === "boot" && existsSync(${JSON.stringify(join(root, "fail-boot"))})) { console.error("native boot failed"); process.exit(9); }`;
  writeFileSync(join(bin, "xcrun"), xcrun, { mode: 0o700 });
  writeFileSync(
    join(bin, "adb"),
    `#!${process.execPath}\nconsole.log("List of devices attached");`,
    { mode: 0o700 },
  );
  const logs: string[] = [];

  try {
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ANDROID_HOME: join(root, "sdk"),
          XDG_STATE_HOME: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: await child.exited,
        output: await new Response(child.stdout).text(),
        errors: await new Response(child.stderr).text(),
      };
    };
    const status = await run(["status"]);
    expect(status.code).toBe(0);
    expect(status.output.trim().split("\n")).toHaveLength(1);
    expect(status.errors).toBe("");
    expect(JSON.parse((await run(["status", "--json"])).output)).toMatchObject({
      capacity: { ios: 3, android: 1 },
      leases: [],
      waiting: [],
    });
    expect((await run(["status", "--verbose"])).output).toContain("android: 0/1");

    writeFileSync(join(root, "fail-boot"), "fail");
    const failed = await run(["acquire", "test-device", "--owner", "output test", "--json"]);
    const receipt = JSON.parse(failed.output);
    logs.push(receipt.log);
    expect(failed.code).toBe(1);
    expect(receipt.error).toContain("native boot failed");
    expect(failed.errors.trim().split("\n")).toHaveLength(1);
    expect(failed.errors).toContain("log:");
    expect(failed.errors).not.toContain("granted");
  } finally {
    for (const log of logs) rmSync(join(log, ".."), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
