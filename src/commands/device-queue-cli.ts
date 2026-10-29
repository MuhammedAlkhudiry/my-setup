#!/usr/bin/env bun

// Leases each project's fixed pool of iOS simulators and Android emulators to agent sessions so only a few run at once;
// further requests wait in a first-come queue. A granted device is booted, slimmed, and ready. The
// browser-simulator-routing skill tells agents when to use it.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";

import { DEVICE_POOL, type PoolDevice, SLIM_FLAGS } from "../../config/device-pool";
import {
  DEVICE_QUEUE,
  type Device,
  type Headroom,
  type Platform,
  type SimRuntime,
  decide,
  alreadyShutDown,
  coldBootConfig,
  keepTicket,
  laneLimits,
  poolMembers,
  reapQueue,
  releaseLease,
  simulatorDeviceType,
  updateHeadroom,
} from "../lib/device-queue";

import { agentOutput } from "../lib/agent-output";
import { queueDirectory, readQueueState, withQueueState as withState } from "../lib/queue-store";
import { timedCommand } from "../lib/timed-command";

agentOutput("device-queue", {
  nativeJson: true,
  summary: (output) => {
    try {
      const receipt = JSON.parse(output);
      return `device-queue: ${receipt.status}${receipt.name ? ` ${receipt.name}` : ""}${receipt.id ? ` ${receipt.id}` : ""}${receipt.serial ? ` ${receipt.serial}` : ""}`;
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
// avdslim does not follow a symlinked AVD directory.
const AVD_HOME = process.env.ANDROID_AVD_HOME || realPath(join(homedir(), ".android/avd"));
const SIM_DEVICES = join(homedir(), "Library/Developer/CoreSimulator/Devices");
const POLL_MS = 10_000;
const BOOT_TIMEOUT_MS = 5 * 60_000;
const SLIM_TIMEOUT_MS = 10 * 60_000;
/** A stock Play image disables a handful of packages; avdslim disables dozens, and the change persists across boots. */
const SLIM_DISABLED_PACKAGES = 20;
const STILL_QUEUED_EXIT_CODE = 75;

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

type Shutdowns = ReturnType<typeof reapQueue>;

const log = (line: string) => {
  mkdirSync(queueDirectory(), { recursive: true });
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
};

/** A host probe that ran past its time limit under load; acquire retries it instead of exiting. */
class ProbeTimeout extends Error {}

const PROBE_TIMEOUT_MS = Number(process.env.DEVICE_QUEUE_PROBE_TIMEOUT_MS) || 30_000;

async function run(
  command: string,
  args: string[],
  optional = false,
  timeout = PROBE_TIMEOUT_MS,
): Promise<string> {
  const result = await timedCommand(command, args, {
    timeout,
    env: { ...process.env, ANDROID_AVD_HOME: AVD_HOME },
  });
  if (result.timedOut && !optional)
    throw new ProbeTimeout(
      `${command} ${args.join(" ")} timed out after ${Math.round(timeout / 1000)}s`,
    );
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
    // The emulator console can hang while the guest is busy, so ask adbd first and never fail on either probe.
    const avd =
      (await run(ADB, ["-s", serial, "shell", "getprop", "ro.boot.qemu.avd_name"], true)).trim() ||
      (await run(ADB, ["-s", serial, "emu", "avd", "name"], true)).split(/\r?\n/)[0]?.trim();
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

/** Reclaiming a device is best effort: one already off counts as done, and a failure leaves it for the next reap. */
async function shutDown(device: Device, reason: string) {
  const command =
    device.platform === "ios"
      ? (["xcrun", ["simctl", "shutdown", device.id]] as const)
      : device.serial
        ? ([ADB, ["-s", device.serial, "emu", "kill"]] as const)
        : undefined;
  if (!command) return;

  const result = await timedCommand(command[0], [...command[1]], { timeout: 60_000 });
  if (result.failed && !alreadyShutDown(result.stderr))
    log(
      `could not shut down ${device.name} (${device.id}): ${result.stderr.trim() || result.shortMessage}`,
    );
  else log(`shut down ${device.name} (${device.id}): ${reason}`);
}

async function shutDownAll(shutdowns: Shutdowns) {
  for (const { device, reason } of shutdowns) await shutDown(device, reason);
}

/** CPU idle from the decayed per-process averages `ps` reports, and free memory as macOS memory_pressure reports it. */
async function sampleHeadroom(): Promise<Pick<Headroom, "cpuIdle" | "memoryFree">> {
  const busy = (await run("ps", ["-A", "-o", "%cpu="], true))
    .split("\n")
    .reduce((total, line) => total + (Number(line.trim()) || 0), 0);
  const free = (await run("memory_pressure", [], true)).match(/free percentage:\s*(\d+)%/)?.[1];

  return {
    cpuIdle: Math.max(0, 100 - busy / availableParallelism()),
    memoryFree: free === undefined ? 0 : Number(free),
  };
}

function poolRequest(project: string, platform: string, kind: string | undefined): PoolDevice[] {
  const form = "device-queue acquire <project> <ios|android> [--kind <kind>]";
  const projects = [...new Set(DEVICE_POOL.map((member) => member.project))];
  if (!projects.includes(project))
    throw new InputError(`Lease by project: ${form}. Projects: ${projects.join(", ")}`);
  if (platform !== "ios" && platform !== "android")
    throw new InputError(`Lease by project and platform: ${form}`);

  const members = poolMembers(DEVICE_POOL, project, platform, kind);
  if (!members.length) {
    const kinds = DEVICE_POOL.filter(
      (member) => member.project === project && member.platform === platform,
    ).map((member) => member.kind);
    throw new InputError(
      `No ${project} ${platform} device of kind ${kind}; kinds: ${kinds.join(", ")}`,
    );
  }
  return members;
}

/**
 * Pool simulators are created once, on the newest installed iOS, and kept; the queue never creates any other device.
 * When that runtime lacks the member's device type, the closest iPhone it supports stands in.
 */
async function createSimulator(member: PoolDevice): Promise<void> {
  const runtimes = JSON.parse(
    await run("xcrun", ["simctl", "list", "devicetypes", "runtimes", "-j"]),
  ).runtimes as SimRuntime[];
  const runtime = runtimes
    .filter((candidate) => candidate.isAvailable && candidate.platform === "iOS")
    .sort((a, b) => Bun.semver.order(a.version, b.version))
    .at(-1);
  if (!runtime) throw new Error(`No iOS runtime to create ${member.name}`);
  const deviceType = simulatorDeviceType(member, runtime);
  if (!deviceType)
    throw new Error(`iOS ${runtime.version} has no iPhone device type to create ${member.name}`);

  const udid = (
    await run("xcrun", ["simctl", "create", member.name, deviceType, runtime.identifier])
  ).trim();
  if (member.locale) {
    const preferences = join(
      SIM_DEVICES,
      udid,
      "data/Library/Preferences/.GlobalPreferences.plist",
    );
    await run("defaults", [
      "write",
      preferences,
      "AppleLanguages",
      "-array",
      member.locale.split("_")[0]!,
    ]);
    await run("defaults", ["write", preferences, "AppleLocale", member.locale]);
  }
  log(`created pool simulator ${member.name} (${udid}) as ${deviceType} on iOS ${runtime.version}`);
}

/**
 * Matches pool members to devices on this Mac. A missing simulator is created only when every existing match is leased
 * to someone else, one at a time, so spare members of a kind exist only after the pool has needed them.
 */
async function poolDevices(
  members: PoolDevice[],
  holder: { owner: string; agentPid: number },
): Promise<{ devices: Map<string, Device>; candidates: Device[] }> {
  let devices = await listDevices();
  const find = (member: PoolDevice) =>
    [...devices.values()].find(
      (device) => device.platform === member.platform && device.name === member.name,
    );
  const missing = members.filter((member) => !find(member));
  const { leases } = readQueueState();
  const available = members.some((member) => {
    const lease = leases[find(member)?.id ?? ""];
    const device = find(member);
    return (
      device && (!lease || (lease.owner === holder.owner && lease.agentPid === holder.agentPid))
    );
  });

  if (missing[0] && !available) {
    if (missing[0].platform === "android")
      throw new Error(`Missing AVD ${missing[0].name}; create it once with avdslim create`);
    await createSimulator(missing[0]);
    devices = await listDevices();
  }
  return { devices, candidates: members.map(find).filter((device) => device !== undefined) };
}

async function readySimulator(device: Device): Promise<boolean> {
  if (!Bun.which("simslim"))
    throw new Error("simslim is missing; brew install mobai-app/tap/simslim");
  const bootstatus = () =>
    run("xcrun", ["simctl", "bootstatus", device.id, "-b"], false, BOOT_TIMEOUT_MS);

  if (!device.booted) await run("xcrun", ["simctl", "boot", device.id]);
  await bootstatus();
  // A slim simulator stays slim across reboots; only a stock or recreated one needs the slimming reboot.
  const verify = await timedCommand("simslim", ["verify", device.id, ...SLIM_FLAGS.ios], {
    timeout: 60_000,
  });
  if (verify.exitCode === 0) return false;

  await run("simslim", ["on", device.id, ...SLIM_FLAGS.ios], false, SLIM_TIMEOUT_MS);
  await bootstatus();
  log(`slimmed ${device.name} (${device.id})`);
  return true;
}

/**
 * Pool emulators always cold-boot. Restoring a quick-boot snapshot with host graphics hung the emulator's main loop until
 * its crash detector killed it, and a snapshot saved under other graphics settings fails to load. Slimming lives on the
 * data partition, so a cold boot (about 15 seconds) comes up slim; stale snapshots are deleted to free their disk space.
 */
function requireColdBoot(avd: string) {
  const directory = join(AVD_HOME, `${avd}.avd`);
  const path = join(directory, "config.ini");
  if (!existsSync(path)) return;

  const config = readFileSync(path, "utf8");
  const cold = coldBootConfig(config);
  if (cold !== config) {
    writeFileSync(path, cold);
    log(`turned off quick boot for ${avd}`);
  }
  const snapshots = join(directory, "snapshots");
  if (existsSync(snapshots) && readdirSync(snapshots).length) {
    rmSync(snapshots, { recursive: true, force: true });
    log(`deleted quick-boot snapshots of ${avd}`);
  }
}

async function startEmulator(avd: string): Promise<string> {
  const used = new Set((await run(ADB, ["devices"], true)).match(/(?<=^emulator-)\d+/gm) ?? []);
  const port = Array.from({ length: 16 }, (_, index) => String(5554 + index * 2)).find(
    (candidate) => !used.has(candidate),
  );
  if (!port) throw new Error("No free emulator console port");

  requireColdBoot(avd);
  // The emulator outlives this command and keeps its window, with hardware graphics and no snapshot to load or save.
  // After a crash, every later launch otherwise waits on a hidden crash-report consent dialog and never boots.
  const output = openSync(join(queueDirectory(), `emulator-${avd}.log`), "a");
  const flags = ["-no-boot-anim", "-no-snapshot", "-gpu", "host", "-crash-report-mode", "never"];
  spawn(EMULATOR, ["-avd", avd, "-port", port, ...flags], {
    detached: true,
    stdio: ["ignore", output, output],
    env: { ...process.env, ANDROID_AVD_HOME: AVD_HOME },
  }).unref();
  return `emulator-${port}`;
}

async function readyEmulator(device: Device): Promise<{ serial: string; slimmed: boolean }> {
  if (!Bun.which("avdslim")) throw new Error("avdslim is missing; see system-tools status");
  const serial = device.serial ?? (await startEmulator(device.id));
  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  while (
    (await run(ADB, ["-s", serial, "shell", "getprop", "sys.boot_completed"], true)).trim() !== "1"
  ) {
    if (Date.now() > deadline)
      throw new Error(`${device.name} did not finish booting within 5 minutes`);
    await Bun.sleep(2_000);
  }
  const disabled = (await run(ADB, ["-s", serial, "shell", "pm", "list", "packages", "-d"])).match(
    /^package:/gm,
  );
  if ((disabled?.length ?? 0) >= SLIM_DISABLED_PACKAGES) return { serial, slimmed: false };

  await run("avdslim", ["on", serial, ...SLIM_FLAGS.android], false, SLIM_TIMEOUT_MS);
  log(`slimmed ${device.name} (${serial})`);
  return { serial, slimmed: true };
}

async function acquire(
  project: string,
  platform: string,
  kind: string | undefined,
  owner: string,
  waitSeconds: number,
) {
  const members = poolRequest(project, platform, kind);
  const agentPid = await findAgentPid();
  const deadline = Date.now() + waitSeconds * 1000;
  let lastReport = "";

  const queued = async () => {
    if (Date.now() >= deadline) {
      if (cli.options.json)
        console.log(
          JSON.stringify({
            status: "queued",
            project,
            platform,
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
  };

  while (true) {
    const ticket = { project, platform: platform as Platform, kind, owner, agentPid };
    let probed;
    try {
      const { devices, candidates } = await poolDevices(members, { owner, agentPid });
      probed = {
        devices,
        candidates,
        busy: await busyDevices(devices),
        sample: await sampleHeadroom(),
      };
    } catch (error) {
      if (!(error instanceof ProbeTimeout)) throw error;
      log(`probe for "${owner}" failed, retrying: ${error.message}`);
      // The probe already waited out its time limit, so retry at once unless the wait is over.
      await withState((state) => keepTicket(state, ticket, Date.now()));
      if (Date.now() >= deadline) await queued();
      continue;
    }
    const { devices, candidates, busy, sample } = probed;
    const now = Date.now();
    const request = { ...ticket, candidates };
    const { shutdowns, decision } = await withState((state) => {
      state.headroom = updateHeadroom(state.headroom, sample, now);
      const limits = laneLimits(state.headroom.open);
      return {
        shutdowns: reapQueue(state, devices, now, isAlive, busy, limits),
        decision: decide(state, request, devices, now, limits.slots[request.platform]),
      };
    });
    await shutDownAll(shutdowns);

    if (decision.granted) {
      const device = devices.get(decision.id)!;
      const waited = Math.round(decision.waitedMs / 60_000);
      if (!decision.renewed)
        log(
          `lease ${device.name} (${device.id}) to "${owner}"${decision.adopted ? ", already booted" : ""}${waited > 0 ? `, after waiting ${waited}m` : ""}`,
        );
      const started = Date.now();
      const ready =
        device.platform === "ios"
          ? { serial: undefined, slimmed: await readySimulator(device) }
          : await readyEmulator(device);
      console.log(
        JSON.stringify({
          status: "granted",
          platform: device.platform,
          project,
          kind: DEVICE_POOL.find(
            (member) => member.platform === device.platform && member.name === device.name,
          )?.kind,
          id: device.id,
          name: device.name,
          ...(ready.serial ? { serial: ready.serial } : {}),
          ready: true,
          slimmed: ready.slimmed,
          readyMs: Date.now() - started,
        }),
      );
      return;
    }
    if (process.env.MY_SETUP_OUTPUT === "verbose" && decision.report !== lastReport)
      console.error(decision.report);
    lastReport = decision.report;
    await queued();
  }
}

async function release(id: string) {
  const devices = await listDevices();
  const lease = await withState((state) => releaseLease(state, id));
  const device = devices.get(id);

  if (lease)
    log(
      `released ${device?.name ?? id} (${id}) by "${lease.owner}"${device?.booted ? ", kept warm" : ""}`,
    );
  console.log(JSON.stringify({ status: "released", id, warm: device?.booted === true }));
}

class DeviceCommandTimeout extends Error {}

async function runDeviceCommand(id: string, owner: string, seconds: number, argv: string[]) {
  if (!argv.length) throw new InputError("Pass -- followed by a device command");
  const agentPid = await findAgentPid();
  const lease = await withState((state) => {
    const current = state.leases[id];
    if (
      !current ||
      current.owner !== owner ||
      (current.agentPid && agentPid && current.agentPid !== agentPid)
    )
      return false;
    current.renewedAt = Date.now();
    return true;
  });
  if (!lease)
    throw new InputError(`Lease ${id} with --owner "${owner}" before running a device command`);

  const result = await timedCommand(argv[0]!, argv.slice(1), { timeout: seconds * 1000 });
  if (result.timedOut)
    throw new DeviceCommandTimeout(`${argv[0]} exceeded ${seconds}s; process group killed`);
  if (result.failed)
    throw new Error(
      `${argv[0]} exited ${result.exitCode}: ${result.stderr || result.shortMessage}`,
    );
  console.log(JSON.stringify({ status: "ran", id, output: result.stdout }));
}

async function status(options: { json?: boolean }) {
  const devices = await listDevices();
  const busy = await busyDevices(devices);
  const sample = await sampleHeadroom();
  const now = Date.now();
  const { shutdowns, state, limits } = await withState((state) => {
    state.headroom = updateHeadroom(state.headroom, sample, now);
    const limits = laneLimits(state.headroom.open);
    return {
      shutdowns: reapQueue(state, devices, now, isAlive, busy, limits),
      state: structuredClone(state),
      limits,
    };
  });
  await shutDownAll(shutdowns);

  if (options.json) {
    console.log(
      JSON.stringify({
        status: "ok",
        capacity: DEVICE_QUEUE.maxRunning,
        slots: limits.slots,
        headroom: state.headroom,
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
      `${platform}: ${leases.length + loose.length}/${limits.slots[platform]} slots in use`,
    );
    for (const lease of leases) {
      console.log(
        `  leased    ${lease.name}${lease.kind ? ` (${lease.project} ${lease.kind})` : ""} -> "${lease.owner}" (held ${ago(lease.acquiredAt)}, active ${ago(lease.renewedAt)} ago)`,
      );
    }
    for (const device of loose) {
      console.log(
        `  unleased  ${device.name} ${device.id} (seen ${ago(state.unleasedSince[device.id] ?? now)})`,
      );
    }
    queue.forEach((ticket, index) =>
      console.log(
        `  queue #${index + 1} "${ticket.owner}" for ${ticket.project ?? ticket.id} ${ticket.kind ?? ""} (waiting ${ago(ticket.createdAt)})`,
      ),
    );
  }
  const { cpuIdle, memoryFree, open } = state.headroom!;
  console.log(
    `headroom: ${Math.round(cpuIdle)}% CPU idle, ${memoryFree}% memory free; extra lanes ${open ? "open" : "closed"}`,
  );
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

function requireCommandTimeout(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300)
    throw new InputError("Device command timeout must be between 1 and 300 seconds");
  return seconds;
}

const cli = cac("device-queue")
  .option("--json", "Return a structured receipt")
  .option("--verbose", "Print detailed output");

cli
  .command(
    "acquire [project] [platform]",
    "Lease a ready, slimmed pool device for a project, waiting in the queue when every slot is taken",
  )
  .option("--kind <kind>", "Pool device kind, such as main, small, or rtl")
  .option("--owner <title>", "Thread title of the session taking the lease")
  .option(
    "--wait-seconds <seconds>",
    "How long to wait before exiting with code 75 while still queued",
    { default: 540 },
  )
  .action(
    (
      project: string | undefined,
      platform: string | undefined,
      options: { kind?: string; owner?: string; waitSeconds: number },
    ) =>
      acquire(
        project ?? "",
        platform ?? "",
        options.kind,
        requireOwner(options.owner),
        requireWait(options.waitSeconds),
      ),
  );

cli.command("release <id>", "End a lease and keep one device warm").action(release);

cli
  .command("run <id>", "Run a leased device command with a process-group timeout")
  .option("--owner <title>", "Thread title holding the lease")
  .option("--timeout-seconds <seconds>", "Kill a hung command after this time", { default: 120 })
  .action((id: string, options: { owner?: string; timeoutSeconds: number }) => {
    const separator = process.argv.indexOf("--");
    const command = separator < 0 ? [] : process.argv.slice(separator + 1);
    return runDeviceCommand(
      id,
      requireOwner(options.owner),
      requireCommandTimeout(options.timeoutSeconds),
      command,
    );
  });

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
  const exitCode =
    error instanceof DeviceCommandTimeout ? 124 : !parsed || error instanceof InputError ? 2 : 1;
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
