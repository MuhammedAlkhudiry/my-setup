import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { execa } from "execa";

import { openExpoDevelopmentClient } from "./project-environment/expo";
import { findSimulator } from "./project-environment/simulator";
import {
  getActiveProject,
  getActiveProjects,
  getProjectLanes,
  selectProjectLane,
  type Lane,
} from "./project-lanes";
import type { LaneServiceDefinition } from "./lanes-config";

export type LaneServiceState =
  | "running"
  | "starting"
  | "stopped"
  | "failed"
  | "degraded"
  | "crash-looping"
  | "unreachable"
  | "unavailable";

export interface LaneServiceStatus {
  id: string;
  name: string;
  state: LaneServiceState;
  manageable: boolean;
  managed: boolean;
  command?: string;
  directory?: string;
  logPath?: string;
  pid?: number;
  residentBytes?: number;
  detail?: string;
}

export interface LaneServicesStatus {
  project: string;
  lane: string;
  path: string;
  services: LaneServiceStatus[];
}

export interface LaneServiceReload {
  project: string;
  lane: string;
  service: string;
  connectedClients: number;
  restarted: boolean;
}

interface ServiceContext {
  lane: Lane;
  definition: LaneServiceDefinition;
  directory: string;
  executable: string;
  args: string[];
  command: string;
  label: string;
  plistPath: string;
  logPath: string;
}

interface ObservedProcess {
  pid: number;
  parentPid: number;
  command: string;
  directory: string;
}

interface ProcessMemory {
  pid: number;
  parentPid: number;
  residentBytes: number;
}

interface LaneProcessSnapshot {
  observed: ObservedProcess[];
  memory: ProcessMemory[];
}

const userId = process.getuid?.();
if (userId === undefined) throw new Error("lanes services requires macOS");

const launchDomain = `gui/${userId}`;
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local/state");
const serviceStateDirectory = join(stateHome, "lanes/services");
const launchAgentsDirectory = join(homedir(), "Library/LaunchAgents");

export async function listLaneServiceStatuses(
  projectId?: string,
  laneId?: string,
  options: { siteTimeout?: number } = {},
): Promise<LaneServicesStatus[]> {
  const lanes = selectedLanes(projectId, laneId);
  const snapshot = processSnapshot();
  return Promise.all(
    lanes.map(async (lane) => {
      const services = lane.project.services.map((service) =>
        serviceStatus(serviceContext(lane, service), snapshot),
      );
      const frontendStopped = services.some(
        ({ id, state }) => id === "frontend" && state === "stopped",
      );
      return {
        project: lane.project.id,
        lane: lane.id,
        path: lane.path,
        services: [
          frontendStopped
            ? stoppedSiteStatus()
            : await siteStatus(lane, options.siteTimeout ?? 3_000),
          ...services,
        ],
      };
    }),
  );
}

function stoppedSiteStatus(): LaneServiceStatus {
  return {
    id: "site",
    name: "Site",
    state: "stopped",
    manageable: false,
    managed: false,
    detail: "Frontend is stopped",
  };
}

export function verifyLaneServiceDefinitions(projectId?: string, laneId?: string): void {
  for (const lane of selectedLanes(projectId, laneId)) {
    for (const definition of lane.project.services) {
      const context = serviceContext(lane, definition);
      if (!serviceAvailable(context)) {
        throw new Error(
          `${lane.project.id}/${lane.id}/${definition.id} is unavailable: ${context.command} in ${context.directory}`,
        );
      }
    }
  }
}

export async function startLaneService(
  projectId: string,
  laneId: string,
  serviceId: string,
): Promise<LaneServicesStatus> {
  const lane = explicitLane(projectId, laneId);
  for (const definition of selectedServices(lane, serviceId)) {
    await startService(serviceContext(lane, definition));
  }
  return laneServicesStatus(lane);
}

export async function stopLaneService(
  projectId: string,
  laneId: string,
  serviceId: string,
): Promise<LaneServicesStatus> {
  const lane = explicitLane(projectId, laneId);
  await stopLaneServicesForOperation(lane, serviceId);
  return laneServicesStatus(lane);
}

export async function stopLaneServices(
  projectId: string,
  laneId: string,
  serviceId: string,
): Promise<void> {
  await stopLaneServicesForOperation(explicitLane(projectId, laneId), serviceId);
}

async function stopLaneServicesForOperation(lane: Lane, serviceId: string): Promise<void> {
  for (const definition of selectedServices(lane, serviceId)) {
    await stopService(serviceContext(lane, definition));
  }
}

export async function restartLaneService(
  projectId: string,
  laneId: string,
  serviceId: string,
): Promise<LaneServicesStatus> {
  const lane = explicitLane(projectId, laneId);
  for (const definition of selectedServices(lane, serviceId)) {
    const context = serviceContext(lane, definition);
    await stopService(context);
    await startService(context);
  }
  return laneServicesStatus(lane);
}

export async function reloadLaneService(
  projectId: string,
  laneId: string,
  serviceId: string,
): Promise<LaneServiceReload> {
  const lane = explicitLane(projectId, laneId);
  const definition = selectedServices(lane, serviceId)[0];
  if (!definition || serviceId === "all" || definition.id !== "metro") {
    throw new Error("Reload requires one Metro service");
  }
  const context = serviceContext(lane, definition);
  const status = serviceStatus(context);
  const staleInputs =
    status.detail === "Service inputs changed after launch; restart this lane service";
  if (status.state !== "running" && !staleInputs) {
    throw new Error(`${projectId}/${laneId}/${serviceId} is not running`);
  }
  if (staleInputs) {
    await stopService(context);
    await startService(context);
  }
  const port = laneServiceEnvironment(context.directory).EXPO_DEV_SERVER_PORT;
  const metroPort = Number(port);
  if (!Number.isSafeInteger(metroPort) || metroPort < 1 || metroPort > 65_535) {
    throw new Error(`${projectId}/${laneId}/${serviceId} has no valid Expo development port`);
  }
  return {
    project: projectId,
    lane: laneId,
    service: serviceId,
    connectedClients: await broadcastMetroReload(metroPort, staleInputs ? 10_000 : 3_000),
    restarted: staleInputs,
  };
}

export function broadcastMetroReload(port: number, timeoutMilliseconds = 3_000): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const requestId = `lanes-reload-${process.pid}-${Date.now()}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/message?name=lanes`);
    let settled = false;
    let metroAnswered = false;
    const timeout = setTimeout(
      () =>
        fail(
          metroAnswered
            ? `No native app is connected to Metro ${port}`
            : `Metro ${port} did not answer the reload request`,
        ),
      timeoutMilliseconds,
    );

    const requestPeers = (): void => {
      if (!settled && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ version: 2, method: "getpeers", target: "server", id: requestId }),
        );
      }
    };

    const finish = (connectedClients: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolvePromise(connectedClients);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      rejectPromise(new Error(message));
    };

    socket.addEventListener("open", requestPeers);
    socket.addEventListener("message", ({ data }) => {
      try {
        const message = JSON.parse(String(data)) as {
          id?: string;
          result?: Record<string, unknown>;
        };
        if (message.id !== requestId) return;
        metroAnswered = true;
        const connectedClients = Object.values(message.result ?? {}).filter(
          (query) => typeof query === "string" && /(?:^|&)role=(?:ios|android)(?:&|$)/.test(query),
        ).length;
        if (connectedClients === 0) {
          setTimeout(requestPeers, 100);
          return;
        }
        socket.send(JSON.stringify({ version: 2, method: "reload" }));
        setTimeout(() => finish(connectedClients), 25);
      } catch {
        fail(`Metro ${port} returned an invalid reload response`);
      }
    });
    socket.addEventListener("error", () => fail(`Could not connect to Metro ${port}`));
    socket.addEventListener("close", () => {
      if (!settled) fail(`Metro ${port} closed before acknowledging the reload request`);
    });
  });
}

export function laneServiceLogPath(projectId: string, laneId: string, serviceId: string): string {
  const lane = explicitLane(projectId, laneId);
  const definition = selectedServices(lane, serviceId)[0];
  if (!definition || serviceId === "all") throw new Error("Logs require one service id");
  return serviceContext(lane, definition).logPath;
}

export function readLaneServiceLogs(
  projectId: string,
  laneId: string,
  serviceId: string,
  lines = 30,
  raw = false,
): string {
  const path = laneServiceLogPath(projectId, laneId, serviceId);
  if (!existsSync(path)) return "No captured output yet.";
  const size = statSync(path).size;
  const length = Math.min(size, 256 * 1024);
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(length);
  try {
    readSync(descriptor, buffer, 0, length, size - length);
  } finally {
    closeSync(descriptor);
  }
  if (raw) {
    return (
      buffer.toString("utf8").split("\n").slice(-Math.max(1, lines)).join("\n").trimEnd() ||
      "No output captured yet."
    );
  }
  const ansiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const value = buffer.toString("utf8").replace(ansiSequence, "").replaceAll("\r", "");
  return (
    value.split("\n").slice(-Math.max(1, lines)).join("\n").trim() || "No output captured yet."
  );
}

export async function openLaneTarget(
  projectId: string,
  laneId: string,
  target: "phpstorm" | "finder" | "simulator" | "browser",
): Promise<void> {
  const lane = explicitLane(projectId, laneId);
  if (target === "phpstorm") {
    await execa("open", ["-a", "PhpStorm", lane.path]);
    return;
  }
  if (target === "browser") {
    await execa("open", [`https://${lane.project.id}-${lane.id}.test`]);
    return;
  }
  if (target === "finder") {
    await execa("open", ["-a", "Finder", lane.path]);
    return;
  }
  const simulatorName =
    lane.kind === "canonical" ? `${lane.project.name} Main` : `${lane.project.name} ${lane.id}`;
  if (lane.project.mobile?.developmentScheme) {
    const mobileDirectory = resolve(lane.path, lane.project.mobile.directory);
    const port = laneServiceEnvironment(mobileDirectory).EXPO_DEV_SERVER_PORT;
    if (!port) throw new Error(`Managed mobile environment is missing for ${projectId}/${laneId}`);
    openExpoDevelopmentClient({
      port,
      scheme: lane.project.mobile.developmentScheme,
      simulatorName,
    });
    return;
  }
  const document = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "-j", "devices"], {
      encoding: "utf8",
    }),
  ) as Parameters<typeof findSimulator>[0];
  const simulator = findSimulator(document, simulatorName);
  if (!simulator?.udid) throw new Error(`Simulator ${simulatorName} is missing`);
  if (simulator.state !== "Booted") {
    await execa("xcrun", ["simctl", "boot", simulator.udid]);
  }
  await execa("open", ["-a", "Simulator"]);
}

async function laneServicesStatus(lane: Lane): Promise<LaneServicesStatus> {
  const statuses = await listLaneServiceStatuses(lane.project.id, lane.id);
  const status = statuses[0];
  if (!status) throw new Error(`Could not read services for ${lane.project.id}/${lane.id}`);
  return status;
}

function selectedLanes(projectId?: string, laneId?: string): Lane[] {
  if (laneId && !projectId) throw new Error("A lane id requires a project id");
  if (projectId && laneId) return [explicitLane(projectId, laneId)];
  const projects = projectId ? [getActiveProject(projectId)] : getActiveProjects();
  return projects.flatMap(getProjectLanes);
}

function explicitLane(projectId: string, laneId: string): Lane {
  return selectProjectLane(getActiveProjects(), { projectId, laneId });
}

function selectedServices(lane: Lane, serviceId: string): LaneServiceDefinition[] {
  if (serviceId === "all") return lane.project.services;
  const service = lane.project.services.find(({ id }) => id === serviceId);
  if (!service) throw new Error(`Unknown service: ${lane.project.id}/${lane.id}/${serviceId}`);
  return [service];
}

function serviceContext(lane: Lane, definition: LaneServiceDefinition): ServiceContext {
  const directory = resolve(lane.path, definition.directory);
  const environment = laneServiceEnvironment(directory);
  const scriptArguments = environment.EXPO_DEV_SERVER_PORT
    ? ["--port", environment.EXPO_DEV_SERVER_PORT]
    : [];
  const safeKey = `${lane.project.id}.${lane.id}.${definition.id}`.replace(/[^a-zA-Z0-9.-]/g, "-");
  const label = `com.muhammed.lanes.${safeKey}`;
  const executable = (() => {
    if (definition.runner.type === "bun-script") {
      return findExecutable([
        join(homedir(), ".bun/bin/bun"),
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/bun",
      ]);
    }
    if (definition.runner.type === "npm-script") {
      return findExecutable([
        join(homedir(), ".local/share/mise/installs/node/latest/bin/npm"),
        "/opt/homebrew/bin/npm",
        "/usr/local/bin/npm",
      ]);
    }
    return findExecutable([
      join(homedir(), "Library/Application Support/Herd/bin/php"),
      "/opt/homebrew/bin/php",
      "/usr/local/bin/php",
      "/usr/bin/php",
    ]);
  })();
  const args = (() => {
    if (definition.runner.type === "bun-script") {
      return [definition.runner.script, ...scriptArguments];
    }
    if (definition.runner.type === "npm-script") {
      return [
        "run",
        definition.runner.script,
        ...(scriptArguments.length ? ["--", ...scriptArguments] : []),
      ];
    }
    return ["artisan", definition.runner.command];
  })();
  const command = (() => {
    if (definition.runner.type === "artisan") return `php artisan ${definition.runner.command}`;
    const runtime = definition.runner.type === "npm-script" ? "npm run" : "bun";
    return `${runtime} ${[definition.runner.script, ...scriptArguments].join(" ")}`;
  })();
  return {
    lane,
    definition,
    directory,
    executable,
    args,
    command,
    label,
    plistPath: join(launchAgentsDirectory, `${label}.plist`),
    logPath: join(serviceStateDirectory, `${safeKey}.log`),
  };
}

function findExecutable(candidates: string[]): string {
  const executable = candidates.find((path) => existsSync(path));
  if (!executable) {
    throw new Error(`Missing executable: ${candidates.map((path) => basename(path)).join(" or ")}`);
  }
  return executable;
}

function serviceAvailable(context: ServiceContext): boolean {
  if (!existsSync(context.directory)) return false;
  if (context.definition.runner.type === "artisan") {
    return existsSync(join(context.directory, "artisan"));
  }
  const packagePath = join(context.directory, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    const packageDocument = JSON.parse(readFileSync(packagePath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return Boolean(packageDocument.scripts?.[context.definition.runner.script]);
  } catch {
    return false;
  }
}

function serviceStatus(context: ServiceContext, snapshot = processSnapshot()): LaneServiceStatus {
  const base = {
    id: context.definition.id,
    name: context.definition.name,
    manageable: true,
    command: context.command,
    directory: context.directory,
    logPath: context.logPath,
  };
  if (!serviceAvailable(context)) {
    return { ...base, state: "unavailable", managed: false };
  }

  const launchStatus = launchAgentStatus(context.label);
  if (launchStatus.loaded) {
    const residentBytes = launchStatus.pid
      ? processTreeResidentBytes(launchStatus.pid, snapshot.memory)
      : 0;
    const uptime = launchStatus.pid ? processUptimeSeconds(launchStatus.pid) : undefined;
    const crashLooping = Boolean(
      launchStatus.pid &&
      launchStatus.failed &&
      (launchStatus.runs ?? 0) >= 3 &&
      uptime !== undefined &&
      uptime < 15,
    );
    let readinessFailure: string | undefined;
    if (serviceInputsChanged(context)) {
      readinessFailure = "Service inputs changed after launch; restart this lane service";
    } else if (launchStatus.pid) {
      readinessFailure = serviceReadinessFailure(context);
    }

    const status: LaneServiceStatus = {
      ...base,
      state: "starting",
      managed: true,
      ...(launchStatus.pid ? { pid: launchStatus.pid } : {}),
      ...(residentBytes > 0 ? { residentBytes } : {}),
    };
    if (crashLooping) {
      status.state = "crash-looping";
      status.detail = `Restarted ${launchStatus.runs} times; last exit ${launchStatus.exitCode}`;
    } else if (readinessFailure) {
      status.state = "degraded";
      status.detail = readinessFailure;
    } else if (launchStatus.pid) {
      status.state = "running";
    } else if (launchStatus.failed) {
      status.state = "failed";
    }
    return status;
  }
  const external = matchingProcesses(context, snapshot.observed)[0];
  const residentBytes = external ? processTreeResidentBytes(external.pid, snapshot.memory) : 0;
  return external
    ? {
        ...base,
        state: "running",
        managed: false,
        pid: external.pid,
        ...(residentBytes > 0 ? { residentBytes } : {}),
      }
    : { ...base, state: "stopped", managed: false };
}

export async function siteStatus(
  lane: Lane,
  timeout: number,
  request: typeof fetch = fetch,
): Promise<LaneServiceStatus> {
  const firstAttempt = await siteStatusAttempt(lane, timeout, request);
  if (firstAttempt.state === "running") return firstAttempt;
  return siteStatusAttempt(lane, timeout, request);
}

async function siteStatusAttempt(
  lane: Lane,
  timeout: number,
  request: typeof fetch,
): Promise<LaneServiceStatus> {
  try {
    const certificateAuthority = join(
      homedir(),
      "Library/Application Support/Herd/config/valet/CA/LaravelValetCASelfSigned.pem",
    );
    const response = await request(`https://${lane.project.id}-${lane.id}.test`, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeout),
      ...(existsSync(certificateAuthority)
        ? { tls: { ca: readFileSync(certificateAuthority, "utf8") } }
        : {}),
    });
    return {
      id: "site",
      name: "Site",
      state:
        response.ok || (response.status >= 300 && response.status < 400)
          ? "running"
          : "unreachable",
      manageable: false,
      managed: false,
      ...(response.ok || (response.status >= 300 && response.status < 400)
        ? {}
        : { detail: `HTTP ${response.status} ${response.statusText}`.trim() }),
    };
  } catch (error) {
    return {
      id: "site",
      name: "Site",
      state: "unreachable",
      manageable: false,
      managed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function startService(context: ServiceContext): Promise<void> {
  if (!serviceAvailable(context)) {
    throw new Error(
      `${context.definition.name} is unavailable in ${context.lane.project.id}/${context.lane.id}`,
    );
  }
  const current = serviceStatus(context);
  if (current.state === "running") return;

  mkdirSync(dirname(context.logPath), { recursive: true });
  mkdirSync(dirname(context.plistPath), { recursive: true });
  closeSync(openSync(context.logPath, "a"));
  writeFileSync(context.plistPath, launchAgentPlist(context), { mode: 0o600 });
  chmodSync(context.plistPath, 0o600);
  await execa("launchctl", ["bootstrap", launchDomain, context.plistPath]);
  const status = await waitForServiceStart(context);
  if (status.state !== "running") {
    await execa("launchctl", ["bootout", launchDomain, context.plistPath], {
      reject: false,
    });
    rmSync(context.plistPath, { force: true });
    throw new Error(
      `${context.definition.name} failed to become healthy${status.detail ? `: ${status.detail}` : ""}; see ${context.logPath}`,
    );
  }
}

async function waitForServiceStart(
  context: ServiceContext,
  timeoutMilliseconds = 10_000,
): Promise<LaneServiceStatus> {
  const deadline = Date.now() + timeoutMilliseconds;
  let status: LaneServiceStatus;
  do {
    await Bun.sleep(300);
    status = serviceStatus(context);
    if (status.state === "running") return status;
    if (["failed", "crash-looping", "stopped"].includes(status.state)) return status;
  } while (Date.now() < deadline);
  return status;
}

async function stopService(context: ServiceContext): Promise<void> {
  if (existsSync(context.plistPath)) {
    await execa("launchctl", ["bootout", launchDomain, context.plistPath], {
      reject: false,
    });
    rmSync(context.plistPath, { force: true });
  }
  const processes = matchingProcesses(context, processSnapshot().observed);
  const ids = new Set(processes.map(({ pid }) => pid));
  const roots = processes.filter(({ parentPid }) => !ids.has(parentPid));
  for (const item of roots) terminateProcessTree(item.pid, "SIGTERM");
  if (roots.length > 0) await Bun.sleep(600);
  for (const item of roots) {
    try {
      process.kill(item.pid, 0);
      terminateProcessTree(item.pid, "SIGKILL");
    } catch {
      // The process exited after SIGTERM.
    }
  }
}

function launchAgentStatus(label: string): {
  loaded: boolean;
  pid?: number;
  failed: boolean;
  exitCode?: number;
  runs?: number;
} {
  try {
    const output = execFileSync("launchctl", ["print", `${launchDomain}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = output.match(/\bpid = (\d+)/)?.[1];
    const exitCode = output.match(/last exit code = (-?\d+)/)?.[1];
    const runs = output.match(/\bruns = (\d+)/)?.[1];
    return {
      loaded: true,
      ...(pid ? { pid: Number(pid) } : {}),
      ...(exitCode ? { exitCode: Number(exitCode) } : {}),
      ...(runs ? { runs: Number(runs) } : {}),
      failed: exitCode !== undefined && Number(exitCode) !== 0,
    };
  } catch {
    return { loaded: false, failed: false };
  }
}

function processUptimeSeconds(pid: number): number | undefined {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "etime="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!match) return undefined;
    return (
      Number(match[1] ?? 0) * 86_400 +
      Number(match[2] ?? 0) * 3_600 +
      Number(match[3]) * 60 +
      Number(match[4])
    );
  } catch {
    return undefined;
  }
}

function serviceReadinessFailure(context: ServiceContext): string | undefined {
  try {
    if (
      context.definition.runner.type === "artisan" &&
      context.definition.runner.command === "horizon"
    ) {
      const output = execFileSync(context.executable, ["artisan", "horizon:status"], {
        cwd: context.directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2_000,
      });
      if (!/running/i.test(output)) return "Horizon does not report running supervisors";
    }
    if (context.definition.id === "metro") {
      const port = laneServiceEnvironment(context.directory).EXPO_DEV_SERVER_PORT;
      if (port) {
        const output = execFileSync(
          "/usr/bin/curl",
          ["--fail", "--silent", "--max-time", "1", `http://127.0.0.1:${port}/status`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        if (!output.includes("packager-status:running")) return `Metro ${port} is not ready`;
      }
    }
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return `${context.definition.name} readiness failed: ${message}`;
  }
}

function processSnapshot(): LaneProcessSnapshot {
  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
      encoding: "utf8",
    });
  } catch {
    return { observed: [], memory: [] };
  }
  const processes = output
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      residentBytes: Number(match[3]) * 1024,
      command: match[4]!,
    }));
  const observableProcesses = processes.filter(({ command }) =>
    /\b(?:bun|npm)\b.*\b(dev|start(?::lane)?)\b|artisan\s+horizon/.test(command.toLowerCase()),
  );
  const directories = processDirectories(observableProcesses.map(({ pid }) => pid));
  const observed = observableProcesses.flatMap((process) => {
    const { pid } = process;
    const directory = directories.get(pid);
    return directory
      ? [
          {
            pid,
            parentPid: process.parentPid,
            command: process.command.toLowerCase(),
            directory,
          },
        ]
      : [];
  });
  return {
    observed,
    memory: processes.map(({ pid, parentPid, residentBytes }) => ({
      pid,
      parentPid,
      residentBytes,
    })),
  };
}

function processTreeResidentBytes(rootPid: number, processes: ProcessMemory[]): number {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (descendants.has(process.parentPid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return processes
    .filter(({ pid }) => descendants.has(pid))
    .reduce((total, { residentBytes }) => total + residentBytes, 0);
}

function processDirectories(pids: number[]): Map<number, string> {
  const directories = new Map<number, string>();
  if (pids.length === 0) return directories;
  try {
    const output = execFileSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let pid: number | undefined;
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (pid !== undefined && line.startsWith("n")) directories.set(pid, line.slice(1));
    }
  } catch {
    return directories;
  }
  return directories;
}

function matchingProcesses(
  context: ServiceContext,
  observed: ObservedProcess[],
): ObservedProcess[] {
  const expectedDirectory = canonicalPath(context.directory);
  return observed.filter((process) => {
    if (canonicalPath(process.directory) !== expectedDirectory) return false;
    if (context.definition.runner.type === "artisan") {
      return process.command.includes(`artisan ${context.definition.runner.command}`);
    }
    const script = context.definition.runner.script.toLowerCase();
    const runtime = context.definition.runner.type === "npm-script" ? "npm" : "bun";
    return (
      process.command.includes(`${runtime} ${script}`) ||
      process.command.includes(`${runtime} run ${script}`)
    );
  });
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return resolve(dirname(path), readlinkSync(path));
    } catch {
      return resolve(path);
    }
  }
}

function terminateProcessTree(pid: number, signal: NodeJS.Signals): void {
  for (const child of childPids(pid)) terminateProcessTree(child, signal);
  try {
    process.kill(pid, signal);
  } catch {
    // The process already exited.
  }
}

function childPids(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function launchAgentPlist(context: ServiceContext): string {
  const path = [
    join(homedir(), ".local/share/mise/installs/node/latest/bin"),
    join(homedir(), ".bun/bin"),
    join(homedir(), ".local/bin"),
    join(homedir(), "Library/Application Support/Herd/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const environment = {
    HOME: homedir(),
    PATH: path,
    USER: process.env.USER ?? "muhammed",
    LANES_SERVICE_INPUT_FINGERPRINT: serviceInputFingerprint(context),
    ...laneServiceEnvironment(context.directory),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(context.label)}</string>
  <key>ProgramArguments</key>
  <array>${[context.executable, ...context.args].map((value) => `\n    <string>${xml(value)}</string>`).join("")}
  </array>
  <key>WorkingDirectory</key><string>${xml(context.directory)}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(environment)
    .map(([key, value]) => `\n    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>${xml(context.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(context.logPath)}</string>
</dict>
</plist>
`;
}

function serviceInputsChanged(context: ServiceContext): boolean {
  if (!existsSync(context.plistPath)) return false;
  const installed = readFileSync(context.plistPath, "utf8").match(
    /<key>LANES_SERVICE_INPUT_FINGERPRINT<\/key><string>([^<]+)<\/string>/,
  )?.[1];
  return Boolean(installed && installed !== serviceInputFingerprint(context));
}

function serviceInputFingerprint(context: ServiceContext): string {
  const hash = createHash("sha256");
  for (const name of [
    "package.json",
    "bun.lock",
    "bun.lockb",
    "app.json",
    "app.config.js",
    "app.config.ts",
    "vite.config.js",
    "vite.config.ts",
  ]) {
    const path = join(context.directory, name);
    if (existsSync(path)) hash.update(name).update("\0").update(readFileSync(path));
  }
  const expoDevelopmentPort = laneServiceEnvironment(context.directory).EXPO_DEV_SERVER_PORT;
  hash.update("EXPO_DEV_SERVER_PORT\0").update(expoDevelopmentPort ?? "");
  return hash.digest("hex");
}

function laneServiceEnvironment(directory: string): Record<string, string> {
  const path = join(directory, ".env.local");
  if (!existsSync(path)) return {};
  const match = readFileSync(path, "utf8").match(
    /^EXPO_DEV_SERVER_PORT\s*=\s*["']?([^\s"']+)["']?\s*$/m,
  );
  return match?.[1] ? { EXPO_DEV_SERVER_PORT: match[1] } : {};
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
