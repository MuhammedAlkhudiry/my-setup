#!/usr/bin/env bun

// Leases iOS simulators and Android emulators to agent sessions so only a few run at once; further requests wait in a
// first-come queue. The browser-simulator-routing skill tells agents when to use it.

import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { execa } from "execa";

import { DEVICE_QUEUE, type Device, decide, reapQueue, releaseLease } from "../lib/device-queue";

import { agentOutput } from "../lib/agent-output";
import { queueDirectory, withQueueState as withState } from "../lib/queue-store";

agentOutput("device-queue", {
  nativeJson: true,
  summary: (output) => {
    try {
      const receipt = JSON.parse(output);
      return `device-queue: ${receipt.status}${receipt.id ? ` ${receipt.id}` : ""}${receipt.needsBoot ? "; start emulator" : ""}`;
    } catch {
      return `device-queue: ${output
        .trim()
        .split("\n")
        .filter((line) => /^(ios|android):/.test(line))
        .join("; ")}`;
    }
  },
});

const LOG_PATH = join(queueDirectory(), "actions.log");
const ANDROID_SDK = process.env.ANDROID_HOME || join(homedir(), "Library/Android/sdk");
const ADB = Bun.which("adb") ?? join(ANDROID_SDK, "platform-tools/adb");
const EMULATOR = join(ANDROID_SDK, "emulator/emulator");
const POLL_MS = 10_000;
const STILL_QUEUED_EXIT_CODE = 75;

type Shutdowns = ReturnType<typeof reapQueue>;

const log = (line: string) => appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);

async function run(command: string, args: string[], optional = false): Promise<string> {
  const result = await execa(command, args, { reject: false, timeout: 30_000 });
  if (result.failed && !optional)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.shortMessage}`);
  return result.exitCode === 0 ? result.stdout : "";
}

async function listDevices(): Promise<Map<string, Device>> {
  const devices = new Map<string, Device>();

  const simctl = JSON.parse((await run("xcrun", ["simctl", "list", "devices", "-j"])) || "{}");
  for (const sims of Object.values(simctl.devices ?? {}) as Array<
    Array<{ udid: string; name: string; state: string }>
  >) {
    for (const sim of sims) {
      devices.set(sim.udid, {
        id: sim.udid,
        platform: "ios",
        name: sim.name,
        booted: sim.state === "Booted",
      });
    }
  }

  if (existsSync(EMULATOR)) {
    for (const avd of (await run(EMULATOR, ["-list-avds"]))
      .split("\n")
      .map((line) => line.trim())) {
      if (/^[\w.-]+$/.test(avd))
        devices.set(avd, { id: avd, platform: "android", name: avd, booted: false });
    }
  }
  const serials =
    (existsSync(ADB) ? (await run(ADB, ["devices"])).match(/^emulator-\d+/gm) : []) ?? [];
  for (const serial of serials) {
    const avd = (await run(ADB, ["-s", serial, "emu", "avd", "name"])).split(/\r?\n/)[0]?.trim();
    if (avd) devices.set(avd, { id: avd, platform: "android", name: avd, booted: true, serial });
  }
  return devices;
}

function isAlive(pid: number): boolean {
  if (pid === 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The Claude Code or Codex process this command runs under; the lease ends when it exits. 0 when none is found. */
async function findAgentPid(): Promise<number> {
  let pid = process.ppid;

  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const [, parent, command] =
      (await run("ps", ["-o", "ppid=,command=", "-p", String(pid)], true))
        .trim()
        .match(/^(\d+)\s+(.*)$/) ?? [];
    if (!command) return 0;
    if (/(^|\/)(claude|codex)(\s|$)/.test(command)) return pid;
    pid = Number(parent);
  }
  return 0;
}

/**
 * For each booted device, the ancestors of every running command that names it, such as a build or test aimed at it. A
 * lease stays active while its own agent is among them. The devices' own processes are skipped, since an emulator an agent
 * started would otherwise keep its lease active for good.
 */
async function busyDevices(devices: Map<string, Device>): Promise<Map<string, Set<number>>> {
  const rows = (await run("ps", ["-axo", "pid=,ppid=,command="])).split("\n").flatMap((line) => {
    const [, pid, ppid, command] = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/) ?? [];
    return command ? [{ pid: Number(pid), ppid: Number(ppid), command }] : [];
  });
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  const booted = [...devices.values()].filter((device) => device.booted);
  const busy = new Map<string, Set<number>>();

  for (const row of rows) {
    if (/device-queue|qemu-system|\/emulator\/|CoreSimulator\/Devices\//.test(row.command))
      continue;
    for (const device of booted) {
      if (
        !row.command.includes(device.id) &&
        !(device.serial && row.command.includes(device.serial))
      )
        continue;
      const ancestors = busy.get(device.id) ?? new Set<number>();
      for (
        let pid = row.ppid, depth = 0;
        pid > 1 && depth < 30;
        pid = parents.get(pid) ?? 0, depth++
      ) {
        ancestors.add(pid);
      }
      busy.set(device.id, ancestors);
    }
  }
  return busy;
}

async function shutDown(device: Device, reason: string) {
  if (device.platform === "ios") await run("xcrun", ["simctl", "shutdown", device.id]);
  else if (device.serial) await run(ADB, ["-s", device.serial, "emu", "kill"]);
  log(`shut down ${device.name} (${device.id}): ${reason}`);
}

async function shutDownAll(shutdowns: Shutdowns) {
  for (const { device, reason } of shutdowns) await shutDown(device, reason);
}

async function acquire(id: string, owner: string, waitSeconds: number) {
  const agentPid = await findAgentPid();
  const deadline = Date.now() + waitSeconds * 1000;
  let lastReport = "";

  while (true) {
    const devices = await listDevices();
    const device = devices.get(id);
    if (!device) throw new Error(`No simulator UDID or emulator AVD named ${id}`);

    const busy = await busyDevices(devices);
    const now = Date.now();
    const request = { id, platform: device.platform, name: device.name, owner, agentPid };
    const { shutdowns, decision } = await withState((state) => ({
      shutdowns: reapQueue(state, devices, now, isAlive, busy),
      decision: decide(state, request, devices, now),
    }));
    await shutDownAll(shutdowns);

    if (decision.granted) {
      const waited = Math.round(decision.waitedMs / 60_000);
      if (!decision.renewed)
        log(
          `lease ${device.name} (${id}) to "${owner}"${decision.adopted ? ", already booted" : ""}${waited > 0 ? `, after waiting ${waited}m` : ""}`,
        );
      if (device.platform === "ios" && !device.booted) await run("xcrun", ["simctl", "boot", id]);
      console.log(
        JSON.stringify({
          status: "granted",
          platform: device.platform,
          id,
          name: device.name,
          needsBoot: device.platform === "android" && !device.booted,
        }),
      );
      if (device.platform === "android" && !device.booted)
        console.error("Start the emulator yourself now.");
      return;
    }
    if (process.env.MY_SETUP_OUTPUT === "verbose" && decision.report !== lastReport)
      console.error(decision.report);
    lastReport = decision.report;

    if (Date.now() >= deadline) {
      if (cli.options.json)
        console.log(
          JSON.stringify({
            status: "queued",
            id,
            exitCode: STILL_QUEUED_EXIT_CODE,
            error: "Still queued; retry within two minutes to keep your place",
            log: join(process.env.MY_SETUP_OUTPUT_LOG_ROOT!, "full.log"),
          }),
        );
      console.error(
        "Still queued. Run the same command again within 2 minutes to keep your place.",
      );
      process.exit(STILL_QUEUED_EXIT_CODE);
    }
    await Bun.sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

async function release(id: string) {
  const devices = await listDevices();
  const lease = await withState((state) => releaseLease(state, id));
  const device = devices.get(id);

  if (device?.booted) await shutDown(device, `released${lease ? ` by "${lease.owner}"` : ""}`);
  console.log(JSON.stringify({ status: "released", id }));
}

async function status(options: { json?: boolean }) {
  const devices = await listDevices();
  const busy = await busyDevices(devices);
  const now = Date.now();
  const { shutdowns, state } = await withState((state) => ({
    shutdowns: reapQueue(state, devices, now, isAlive, busy),
    state: structuredClone(state),
  }));
  await shutDownAll(shutdowns);

  if (options.json) {
    console.log(
      JSON.stringify({
        status: "ok",
        capacity: DEVICE_QUEUE.maxRunning,
        leases: Object.values(state.leases),
        waiting: Object.values(state.tickets),
        unleased: [...devices.values()].filter(
          (device) => device.booted && !state.leases[device.id],
        ),
      }),
    );
    return;
  }

  const ago = (since: number) => `${Math.round((now - since) / 60_000)}m`;
  for (const platform of ["ios", "android"] as const) {
    const leases = Object.values(state.leases).filter((lease) => lease.platform === platform);
    const loose = [...devices.values()].filter(
      (device) => device.platform === platform && device.booted && !state.leases[device.id],
    );
    const queue = Object.values(state.tickets)
      .filter((ticket) => ticket.platform === platform)
      .sort((a, b) => a.createdAt - b.createdAt);

    console.log(
      `${platform}: ${leases.length + loose.length}/${DEVICE_QUEUE.maxRunning[platform]} slots in use`,
    );
    for (const lease of leases) {
      console.log(
        `  leased    ${lease.name} -> "${lease.owner}" (held ${ago(lease.acquiredAt)}, active ${ago(lease.renewedAt)} ago)`,
      );
    }
    for (const device of loose) {
      console.log(
        `  unleased  ${device.name} ${device.id} (seen ${ago(state.unleasedSince[device.id] ?? now)})`,
      );
    }
    queue.forEach((ticket, index) =>
      console.log(`  queue #${index + 1} "${ticket.owner}" (waiting ${ago(ticket.createdAt)})`),
    );
  }
}

class InputError extends Error {}

function requireOwner(owner: unknown): string {
  if (typeof owner !== "string" || owner.trim() === "")
    throw new InputError('Pass --owner "<thread title>"');
  return owner;
}

function requireWait(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new InputError("Wait must be a finite nonnegative number of seconds");
  return seconds;
}

const cli = cac("device-queue")
  .option("--json", "Return a structured receipt")
  .option("--verbose", "Print detailed output");

cli
  .command(
    "acquire <id>",
    "Lease a simulator (UDID) or emulator (AVD name), waiting in the queue when every slot is taken",
  )
  .option("--owner <title>", "Thread title of the session taking the lease")
  .option(
    "--wait-seconds <seconds>",
    "How long to wait before exiting with code 75 while still queued",
    { default: 540 },
  )
  .action((id: string, options: { owner?: string; waitSeconds: number }) =>
    acquire(id, requireOwner(options.owner), requireWait(options.waitSeconds)),
  );

cli.command("release <id>", "End a lease and shut the device down").action(release);

cli.command("status", "Show slots, leases, unleased devices, and the queue").action(status);

cli.help();
cli.addEventListener("command:*", () => {
  throw new InputError(`Unknown command: ${cli.args.join(" ")}. Run device-queue --help.`);
});

let parsed = false;

try {
  cli.parse(process.argv, { run: false });
  parsed = true;
  if (!cli.matchedCommand && !cli.options.help && process.argv.length === 2)
    throw new InputError("Pass acquire, release, or status; see --help");
  await cli.runMatchedCommand();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = !parsed || error instanceof InputError ? 2 : 1;
  if (process.argv.includes("--json"))
    console.log(
      JSON.stringify({
        status: "failed",
        exitCode,
        error: message,
        log: join(process.env.MY_SETUP_OUTPUT_LOG_ROOT!, "full.log"),
      }),
    );
  console.error(message);
  process.exit(exitCode);
}
