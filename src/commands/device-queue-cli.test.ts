import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./device-queue-cli.ts", import.meta.url).pathname;

/**
 * An idle host, so extra lanes are open whatever the real load: free memory and process CPU come from fakes, and any
 * other `ps` call reaches the real one. `before` runs first in the fake `ps`, such as a hang.
 */
function idleHost(bin: string, before = "") {
  writeFileSync(
    join(bin, "memory_pressure"),
    "#!/bin/zsh -f\nprint 'System-wide memory free percentage: 90%'\n",
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "ps"),
    `#!/bin/zsh -f\n${before}\n[[ "$*" == "-A -o %cpu=" ]] && { print 1.0; exit 0; }\nexec /bin/ps "$@"\n`,
    { mode: 0o700 },
  );
}

test("device queue prints compact success, structured status, verbose detail, and only a logged boot failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-output-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  idleHost(bin);
  const xcrun = `#!${process.execPath}
    import { existsSync } from "node:fs";
    const a = process.argv.slice(2);
    if (a[1] === "list") console.log(JSON.stringify({devices:{runtime:[{udid:"test-device",name:"Harium Main",state:"Shutdown"}]}}));
    else if (a[1] === "boot" && existsSync(${JSON.stringify(join(root, "fail-boot"))})) { console.error("native boot failed"); process.exit(9); }`;
  writeFileSync(join(bin, "xcrun"), xcrun, { mode: 0o700 });
  writeFileSync(join(bin, "simslim"), `#!${process.execPath}`, { mode: 0o700 });
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
      capacity: { ios: 5, android: 2 },
      leases: [],
      waiting: [],
    });
    expect((await run(["status", "--verbose"])).output).toContain("android: 0/2");

    const retired = await run(["acquire", "test-device", "--owner", "output test", "--json"]);
    expect(retired.code).toBe(2);
    expect(JSON.parse(retired.output).error).toContain(
      "device-queue acquire <project> <ios|android>",
    );

    writeFileSync(join(root, "fail-boot"), "fail");
    const failed = await run([
      "acquire",
      "harium",
      "ios",
      "--kind",
      "main",
      "--owner",
      "output test",
      "--json",
    ]);
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
}, 60_000);

test("released pool simulators stay booted, a missing member is created once, and hung leased commands are killed", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-warm-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  idleHost(bin);
  writeFileSync(
    join(bin, "xcrun"),
    `#!${process.execPath}
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const root = ${JSON.stringify(root)};
    const args = process.argv.slice(2);
    const created = existsSync(root+"/created") ? JSON.parse(readFileSync(root+"/created", "utf8")) : [];
    const iphone17Pro = {identifier:"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",name:"iPhone 17 Pro",productFamily:"iPhone"};
    if (args[1] === "list" && args[2] === "devicetypes") console.log(JSON.stringify({devicetypes:[iphone17Pro],runtimes:[{identifier:"ios-old",version:"26.4",platform:"iOS",isAvailable:true,supportedDeviceTypes:[]},{identifier:"ios-new",version:"27.0",platform:"iOS",isAvailable:true,supportedDeviceTypes:[iphone17Pro]}]}));
    else if (args[1] === "list") console.log(JSON.stringify({devices:{runtime:[{udid:"test-device",name:"Harium Main",state:existsSync(root+"/booted")?"Booted":"Shutdown"}, ...created]}}));
    if (args[1] === "create") { const udid = args[2].toLowerCase().replace(" ", "-"); writeFileSync(root+"/created", JSON.stringify([...created, {udid, name:args[2], state:"Shutdown", from:args.slice(3)}])); console.log(udid); }
    if (args[1] === "boot") { writeFileSync(root+"/booted", "yes"); writeFileSync(root+"/boots", String(Number(await Bun.file(root+"/boots").text().catch(()=>"0"))+1)); }
    if (args[1] === "shutdown") throw new Error("Release must leave the simulator warm");`,
    { mode: 0o700 },
  );
  // The simulator verifies slim once it has been slimmed.
  writeFileSync(
    join(bin, "simslim"),
    `#!${process.execPath}
    import { appendFileSync, existsSync } from "node:fs";
    const root = ${JSON.stringify(root)};
    const args = process.argv.slice(2);
    appendFileSync(root+"/simslim", args.join(" ")+"\\n");
    if (args[0] === "verify" && !existsSync(root+"/slim-"+args[1])) process.exit(1);
    if (args[0] === "on") appendFileSync(root+"/slim-"+args[1], "on");`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "defaults"),
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(join(root, "defaults"))}, process.argv.slice(2).join(" ")+"\\n");`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "adb"),
    `#!${process.execPath}\nconsole.log("List of devices attached");`,
    {
      mode: 0o700,
    },
  );

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

    const first = await run(["acquire", "harium", "ios", "--owner", "first", "--json"]);
    expect(first).toMatchObject({ code: 0 });
    expect(JSON.parse(first.output)).toMatchObject({
      id: "test-device",
      kind: "main",
      ready: true,
      slimmed: true,
    });
    expect(JSON.parse((await run(["release", "test-device", "--json"])).output)).toMatchObject({
      status: "released",
      warm: true,
    });
    expect(
      JSON.parse((await run(["acquire", "harium", "ios", "--owner", "second", "--json"])).output),
    ).toMatchObject({
      status: "granted",
      slimmed: false,
    });
    expect(await Bun.file(join(root, "boots")).text()).toBe("1");
    expect(await Bun.file(join(root, "simslim")).text()).toContain(
      "on test-device --except icloud,store,web,pim,photos,connectivity",
    );

    const rtl = await run([
      "acquire",
      "harium",
      "ios",
      "--kind",
      "rtl",
      "--owner",
      "third",
      "--json",
    ]);
    expect(JSON.parse(rtl.output)).toMatchObject({ id: "harium-rtl", kind: "rtl" });
    // A free Harium Main served the requests without a kind, so no spare member was created for them.
    expect(JSON.parse(await Bun.file(join(root, "created")).text())).toEqual([
      expect.objectContaining({
        name: "Harium RTL",
        from: ["com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "ios-new"],
      }),
    ]);
    expect(await Bun.file(join(root, "defaults")).text()).toContain("AppleLanguages -array ar");

    // With Harium Main leased, another main lease gets the next member of that kind, created once.
    const spare = await run([
      "acquire",
      "harium",
      "ios",
      "--kind",
      "main",
      "--owner",
      "fourth",
      "--json",
    ]);
    expect(JSON.parse(spare.output)).toMatchObject({ id: "harium-main 2", name: "Harium Main 2" });
    expect(JSON.parse(await Bun.file(join(root, "created")).text())).toHaveLength(2);

    const timedOut = await run([
      "run",
      "test-device",
      "--owner",
      "second",
      "--timeout-seconds",
      "1",
      "--json",
      "--",
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    expect(timedOut).toMatchObject({ code: 124 });
    expect(JSON.parse(timedOut.output)).toMatchObject({ exitCode: 124 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("acquire retries a timed-out probe and treats a device already off as shut down", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-probe-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Three booted simulators nobody leases: the queue reclaims the extra warm ones, but they are already off.
  writeFileSync(
    join(bin, "xcrun"),
    `#!${process.execPath}
    const args = process.argv.slice(2);
    const sim = (udid, name, state) => ({ udid, name, state });
    if (args[1] === "list") console.log(JSON.stringify({devices:{runtime:[sim("main","Harium Main","Shutdown"),sim("a","Old A","Booted"),sim("b","Old B","Booted"),sim("c","Old C","Booted")]}}));
    if (args[1] === "shutdown") { console.error("Unable to shutdown device in current state: Shutdown"); process.exit(149); }`,
    { mode: 0o700 },
  );
  writeFileSync(join(bin, "simslim"), `#!${process.execPath}\n`, { mode: 0o700 });
  writeFileSync(
    join(bin, "adb"),
    `#!${process.execPath}\nconsole.log("List of devices attached");`,
    {
      mode: 0o700,
    },
  );
  // The first process listing hangs past the probe limit, as under heavy load.
  idleHost(
    bin,
    `[[ "$*" == *-axo* && ! -e ${root}/ps-hung ]] && { touch ${root}/ps-hung; sleep 5; }`,
  );

  try {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "acquire",
        "harium",
        "ios",
        "--kind",
        "main",
        "--owner",
        "probe test",
        "--json",
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ANDROID_HOME: join(root, "sdk"),
          XDG_STATE_HOME: root,
          DEVICE_QUEUE_PROBE_TIMEOUT_MS: "1000",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const code = await child.exited;
    expect([code, await new Response(child.stderr).text()]).toEqual([0, ""]);
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({
      status: "granted",
      id: "main",
    });
    const actions = await Bun.file(join(root, "device-queue/actions.log")).text();
    expect(actions).toContain(
      'probe for "probe test" failed, retrying: ps -axo pid=,ppid=,command= timed out',
    );
    expect(actions).toMatch(/shut down Old [ABC] \(\w\): /);
    expect(actions).not.toContain("could not shut down");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
