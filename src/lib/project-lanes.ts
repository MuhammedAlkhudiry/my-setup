import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { z } from "zod";

import { readLanesConfig, type ActiveProject } from "./lanes-config";
import { verifyExpoDevelopmentClientFreshness } from "./project-environment/expo";
import {
  assertAlwaysEnabledServices,
  assertSimSlimProfile,
  assertSupportedSimSlimVersion,
  disabledLabels,
  expectedDisabledLabels,
  parseDisabledLaunchdLabels,
  parseSimSlimCategories,
  parseSimSlimStatus,
  SIMSLIM_INSTALL_COMMAND,
  simSlimOffArgs,
  simSlimOnArgs,
  type SimSlimCategory,
} from "./project-environment/simslim";
import { findSimulator, type SimulatorDevice } from "./project-environment/simulator";
import type { SimulatorSlimmingProfile } from "./project-environment/types";

const environmentStateSchema = z.object({
  path: z.string().min(1),
  number: z.number().int().nonnegative(),
  kind: z.enum(["canonical", "task"]),
  lastVerifiedAt: z.string().datetime().optional(),
  lastVerifiedRuntimeHash: z.string().optional(),
  lastVerifiedProjectHash: z.string().optional(),
  lastError: z.string().optional(),
  lastErrorAt: z.string().datetime().optional(),
});

const registrySchema = z.object({
  version: z.literal(2),
  projects: z.record(z.string(), z.record(z.string(), environmentStateSchema)),
});

type EnvironmentRecord = z.infer<typeof environmentStateSchema>;
type Registry = z.infer<typeof registrySchema>;

export interface LaneState {
  lastVerifiedAt?: string;
  lastVerifiedRuntimeHash?: string;
  lastVerifiedProjectHash?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface Lane {
  id: string;
  number: number;
  path: string;
  kind: "canonical" | "task";
  project: ActiveProject;
}

export type LaneAvailability = "available" | "occupied";
export type LaneHealth = "ready" | "drifted" | "broken";

export interface LaneStatus {
  lane: Lane;
  state: LaneState;
  availability: LaneAvailability;
  health: LaneHealth;
  occupancyReason?: string;
  healthReason?: string;
}

export type SimulatorSlimmingMode = "project" | "full";

export interface LaneSimulatorSlimmingStatus {
  project: string;
  lane: string;
  simulatorName: string;
  udid?: string;
  initialState?: string;
  mode: SimulatorSlimmingMode;
  expectedDisabled?: number;
  actualDisabled?: number;
  matchesProfile?: boolean;
  error?: string;
}

export interface SimulatorFleetReport {
  operation: "status" | "apply" | "restore";
  simulators: LaneSimulatorSlimmingStatus[];
}

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local/state");
export const LANES_CONFIG_PATH =
  process.env.LANES_CONFIG_PATH || join(configHome, "lanes/projects.json");
export const LANES_STATE_PATH = process.env.LANES_STATE_PATH || join(stateHome, "lanes/state.json");
const stateLockPath = process.env.LANES_STATE_LOCK_PATH || join(stateHome, "lanes/state.lock");
const registryLockRetryDelayMs = 50;
const registryLockTimeoutMs = 10_000;
const projectEnvironmentRuntimeDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "project-environment",
);
const projectEnvironmentCommandPath = resolve(
  projectEnvironmentRuntimeDirectory,
  "../../commands/project-environment.ts",
);
const projectEnvironmentAdaptersDirectory = join(projectEnvironmentRuntimeDirectory, "projects");
const projectDefinitionsPath = resolve(
  projectEnvironmentRuntimeDirectory,
  "../../../config/active-projects.ts",
);

export function projectEnvironmentRuntimeHash(
  runtimeDirectory = projectEnvironmentRuntimeDirectory,
  commandPath = projectEnvironmentCommandPath,
  definitionsPath = projectDefinitionsPath,
): string {
  const hash = createHash("sha256");
  hash.update("command\0").update(readFileSync(commandPath));
  hash.update("definitions\0").update(readFileSync(definitionsPath));
  const adaptersDirectory = join(runtimeDirectory, "projects");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        if (directory === adaptersDirectory && entry.name !== "index.ts") continue;
        hash.update(path.slice(runtimeDirectory.length)).update("\0").update(readFileSync(path));
      }
    }
  };
  visit(runtimeDirectory);
  return hash.digest("hex");
}

export function projectEnvironmentProjectHash(
  lane: Lane,
  adaptersDirectory = projectEnvironmentAdaptersDirectory,
): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      id: lane.project.id,
      name: lane.project.name,
      root: lane.path,
      identity: lane.id,
      slot: lane.number,
      environmentVariable: lane.project.environmentVariable,
      mobile: lane.project.mobile,
      services: lane.project.services,
      simulatorSlimming: lane.project.simulatorSlimming,
    }),
  );
  hash.update("adapter\0").update(readFileSync(join(adaptersDirectory, `${lane.project.id}.ts`)));
  return hash.digest("hex");
}

export function summarizeLaneError(error: string): string {
  const lines = error
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const explicit = lines.find(
    (line) => /^(?:error:|Error:)/.test(line) && !/^error:\s*['"]?\//i.test(line),
  );
  const command = lines.find((line) => line.startsWith("Command failed with exit code"));
  return (explicit ?? command ?? lines[0] ?? "environment command failed")
    .replace(/^error:\s*/i, "")
    .slice(0, 240);
}

function readRegistry(): Registry {
  if (!existsSync(LANES_STATE_PATH)) return { version: 2, projects: {} };
  const value: unknown = JSON.parse(readFileSync(LANES_STATE_PATH, "utf8"));
  return registrySchema.parse(value);
}

function writeRegistry(registry: Registry): void {
  const value = registrySchema.parse(registry);
  mkdirSync(dirname(LANES_STATE_PATH), { recursive: true, mode: 0o700 });
  const temporaryPath = `${LANES_STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, LANES_STATE_PATH);
}

async function withRegistryLock<T>(operation: (registry: Registry) => Promise<T>): Promise<T> {
  mkdirSync(dirname(stateLockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(stateLockPath);
      break;
    } catch {
      if (Date.now() - started >= registryLockTimeoutMs) {
        throw new Error(`Timed out waiting for lanes registry lock: ${stateLockPath}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, registryLockRetryDelayMs));
    }
  }
  const registry = readRegistry();
  try {
    return await operation(registry);
  } finally {
    try {
      writeRegistry(registry);
    } finally {
      rmSync(stateLockPath, { recursive: true, force: true });
    }
  }
}

export function getActiveProject(projectId: string): ActiveProject {
  const project = getActiveProjects().find(({ id }) => id === projectId);
  if (!project) throw new Error(`Unknown active project: ${projectId}`);
  return project;
}

export function getActiveProjects(): ActiveProject[] {
  if (!existsSync(LANES_CONFIG_PATH)) {
    throw new Error(`Lanes configuration is missing: ${LANES_CONFIG_PATH}. Run my-setup install.`);
  }
  return readLanesConfig(LANES_CONFIG_PATH).projects;
}

function projectRecords(registry: Registry, projectId: string): Record<string, EnvironmentRecord> {
  return (registry.projects[projectId] ??= {});
}

function laneFromRecord(project: ActiveProject, id: string, record: EnvironmentRecord): Lane {
  return { id, number: record.number, path: record.path, kind: record.kind, project };
}

function lanesForRegistry(project: ActiveProject, registry: Registry): Lane[] {
  const records = projectRecords(registry, project.id);
  const main = records.main ?? {
    path: project.canonicalRoot,
    number: 0,
    kind: "canonical" as const,
  };
  return [
    laneFromRecord(project, "main", main),
    ...Object.entries(records)
      .filter(([id]) => id !== "main")
      .map(([id, record]) => laneFromRecord(project, id, record))
      .sort((left, right) => left.number - right.number),
  ];
}

export function getProjectLanes(project: ActiveProject): Lane[] {
  return lanesForRegistry(project, readRegistry());
}

export function selectProjectLane(
  projects: ActiveProject[],
  options: { projectId?: string; laneId?: string; cwd?: string } = {},
): Lane {
  const { projectId, laneId, cwd = process.cwd() } = options;
  if (laneId && !projectId) throw new Error("An environment id requires a project id");
  const selected = projectId ? projects.filter((project) => project.id === projectId) : projects;
  if (projectId && selected.length === 0) throw new Error(`Unknown active project: ${projectId}`);
  const lanes = selected.flatMap(getProjectLanes);
  if (projectId && laneId) {
    const explicit = lanes.find(({ id }) => id === laneId);
    if (!explicit) throw new Error(`Unknown environment: ${projectId}/${laneId}`);
    return explicit;
  }
  const resolvedCwd = resolve(cwd);
  const current = lanes.find(({ path }) => {
    const resolvedPath = resolve(path);
    return resolvedCwd === resolvedPath || resolvedCwd.startsWith(`${resolvedPath}${sep}`);
  });
  if (current) return current;
  throw new Error("Current directory is not a registered project environment; pass project and id");
}

function stateFromRecord(record: EnvironmentRecord | undefined): LaneState {
  if (!record) return {};
  const {
    lastVerifiedAt,
    lastVerifiedRuntimeHash,
    lastVerifiedProjectHash,
    lastError,
    lastErrorAt,
  } = record;
  return {
    lastVerifiedAt,
    lastVerifiedRuntimeHash,
    lastVerifiedProjectHash,
    lastError,
    lastErrorAt,
  };
}

function inspectLane(lane: Lane, record: EnvironmentRecord | undefined): LaneStatus {
  const state = stateFromRecord(record);
  const availability = lane.kind === "canonical" ? "available" : "occupied";
  const occupancyReason = lane.kind === "task" ? "task environment" : undefined;
  if (!existsSync(lane.path) || !statSync(lane.path).isDirectory()) {
    return {
      lane,
      state,
      availability,
      health: "broken",
      occupancyReason,
      healthReason: "root missing",
    };
  }
  if (state.lastError) {
    return {
      lane,
      state,
      availability,
      health: "broken",
      occupancyReason,
      healthReason: `${summarizeLaneError(state.lastError)}${state.lastErrorAt ? ` (${state.lastErrorAt})` : ""}`,
    };
  }
  if (!record?.lastVerifiedAt) {
    return {
      lane,
      state,
      availability,
      health: "drifted",
      occupancyReason,
      healthReason: "run lanes provision or lanes repair",
    };
  }
  if (record.lastVerifiedRuntimeHash !== projectEnvironmentRuntimeHash()) {
    return {
      lane,
      state,
      availability,
      health: "drifted",
      occupancyReason,
      healthReason: "shared environment runtime changed; run lanes repair",
    };
  }
  if (record.lastVerifiedProjectHash !== projectEnvironmentProjectHash(lane)) {
    return {
      lane,
      state,
      availability,
      health: "drifted",
      occupancyReason,
      healthReason: "project environment contract changed; run lanes repair",
    };
  }
  return { lane, state, availability, health: "ready", occupancyReason };
}

export async function listProjectLaneStatuses(projectId?: string): Promise<LaneStatus[]> {
  const registry = readRegistry();
  const projects = projectId ? [getActiveProject(projectId)] : getActiveProjects();
  return projects.flatMap((project) =>
    lanesForRegistry(project, registry).map((lane) =>
      inspectLane(lane, registry.projects[project.id]?.[lane.id]),
    ),
  );
}

function assertEnvironmentId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      "Environment id must be a lowercase task name using letters, numbers, and hyphens",
    );
  }
}

function canonicalPath(path: string): string {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Environment root is missing: ${path}`);
  }
  return realpathSync(path);
}

function nextSlot(records: Record<string, EnvironmentRecord>): number {
  const used = new Set(Object.values(records).map(({ number }) => number));
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return slot;
}

function recordForLane(registry: Registry, lane: Lane): EnvironmentRecord {
  const records = projectRecords(registry, lane.project.id);
  return (records[lane.id] ??= {
    path: lane.path,
    number: lane.number,
    kind: lane.kind,
  });
}

function registeredRoots(registry: Registry, project: ActiveProject): string[] {
  return lanesForRegistry(project, registry).map(({ path }) => path);
}

async function runEnvironmentCommand(
  lane: Lane,
  registry: Registry,
  operation: "setup" | "mobile-development" | "verify" | "reset" | "destroy",
  extraArgs: string[] = [],
  compact = false,
  environment: Record<string, string> = {},
): Promise<void> {
  await execa("bun", [projectEnvironmentCommandPath, lane.project.id, operation, ...extraArgs], {
    cwd: lane.path,
    env: {
      ...process.env,
      PROJECT_LANE_ID: lane.id,
      PROJECT_LANE_NUMBER: String(lane.number),
      PROJECT_LANE_DEFINITION_ROOT: lane.path,
      PROJECT_LANE_REGISTERED_ROOTS: JSON.stringify(registeredRoots(registry, lane.project)),
      PROJECT_LANE_SIMSLIM_ENABLED: lane.project.simulatorSlimming ? "1" : "",
      PROJECT_LANE_SIMSLIM_EXCEPT_CATEGORIES:
        lane.project.simulatorSlimming?.exceptCategories.join(",") ?? "",
      PROJECT_LANE_SIMSLIM_KEEP_SERVICES:
        lane.project.simulatorSlimming?.keepServices?.join(",") ?? "",
      [lane.project.environmentVariable]: lane.path,
      ...environment,
    },
    stdio: compact ? "pipe" : "inherit",
  });
}

function simulatorName(lane: Lane): string {
  return lane.kind === "canonical"
    ? `${lane.project.name} Main`
    : `${lane.project.name} ${lane.id}`;
}

async function verifyLane(
  lane: Lane,
  registry: Registry,
  options: { mobile?: boolean; compact?: boolean; liveServices?: boolean } = {},
): Promise<void> {
  const { mobile = false, compact = false, liveServices = true } = options;
  await runEnvironmentCommand(
    lane,
    registry,
    "verify",
    mobile ? ["--mobile-development"] : [],
    compact,
    { PROJECT_LANE_VERIFY_LIVE_SERVICES: liveServices ? "1" : "0" },
  );
  if (mobile && lane.project.mobile) {
    verifyExpoDevelopmentClientFreshness({
      mobileDirectory: resolve(lane.path, lane.project.mobile.directory),
      simulatorName: simulatorName(lane),
      bundleIdentifier: lane.project.mobile.bundleIdentifier,
    });
  }
  const record = recordForLane(registry, lane);
  record.lastVerifiedAt = new Date().toISOString();
  record.lastVerifiedRuntimeHash = projectEnvironmentRuntimeHash();
  record.lastVerifiedProjectHash = projectEnvironmentProjectHash(lane);
  delete record.lastError;
  delete record.lastErrorAt;
}

function recordFailure(record: EnvironmentRecord, error: unknown): void {
  record.lastError = error instanceof Error ? error.message : String(error);
  record.lastErrorAt = new Date().toISOString();
}

export async function provisionProjectLane(
  projectId: string,
  laneId: string,
  options: { root?: string; mobile?: boolean; compact?: boolean } = {},
): Promise<Lane> {
  assertEnvironmentId(laneId);
  const project = getActiveProject(projectId);
  const requestedRoot = canonicalPath(
    laneId === "main" ? (options.root ?? project.canonicalRoot) : (options.root ?? process.cwd()),
  );
  const canonicalRoot = canonicalPath(project.canonicalRoot);
  if (laneId === "main" && requestedRoot !== canonicalRoot) {
    throw new Error(`${projectId}/main must use the canonical root ${project.canonicalRoot}`);
  }
  if (laneId !== "main" && requestedRoot === canonicalRoot) {
    throw new Error("Use identity main for the canonical project clone");
  }

  return withRegistryLock(async (registry) => {
    const records = projectRecords(registry, projectId);
    const existing = records[laneId];
    if (existing && canonicalPath(existing.path) !== requestedRoot) {
      throw new Error(`${projectId}/${laneId} is already registered at ${existing.path}`);
    }
    for (const [otherProjectId, environments] of Object.entries(registry.projects)) {
      for (const [otherId, environment] of Object.entries(environments)) {
        if (
          `${otherProjectId}/${otherId}` !== `${projectId}/${laneId}` &&
          resolve(environment.path) === requestedRoot
        ) {
          throw new Error(`Environment root is already registered as ${otherProjectId}/${otherId}`);
        }
      }
    }
    const record = (records[laneId] ??= {
      path: requestedRoot,
      number: laneId === "main" ? 0 : nextSlot(records),
      kind: laneId === "main" ? "canonical" : "task",
    });
    const lane = laneFromRecord(project, laneId, record);
    try {
      await runEnvironmentCommand(lane, registry, "setup", [], options.compact);
      if (options.mobile) {
        await runEnvironmentCommand(lane, registry, "mobile-development", [], options.compact);
      }
      await verifyLane(lane, registry, {
        mobile: options.mobile,
        compact: options.compact,
        liveServices: false,
      });
    } catch (error) {
      recordFailure(record, error);
      throw error;
    }
    return lane;
  });
}

export async function verifyProjectLane(
  projectId?: string,
  laneId?: string,
  options: { cwd?: string; mobile?: boolean; compact?: boolean } = {},
): Promise<Lane> {
  const lane = selectProjectLane(getActiveProjects(), { projectId, laneId, cwd: options.cwd });
  return withRegistryLock(async (registry) => {
    const record = recordForLane(registry, lane);
    try {
      await verifyLane(lane, registry, options);
    } catch (error) {
      recordFailure(record, error);
      throw error;
    }
    return lane;
  });
}

export async function repairProjectLane(
  projectId?: string,
  laneId?: string,
  options: { cwd?: string; mobile?: boolean; compact?: boolean } = {},
): Promise<Lane> {
  const lane = selectProjectLane(getActiveProjects(), { projectId, laneId, cwd: options.cwd });
  return withRegistryLock(async (registry) => {
    const record = recordForLane(registry, lane);
    try {
      await runEnvironmentCommand(lane, registry, "setup", [], options.compact);
      if (options.mobile) {
        await runEnvironmentCommand(lane, registry, "mobile-development", [], options.compact);
      }
      await verifyLane(lane, registry, { ...options, liveServices: false });
    } catch (error) {
      recordFailure(record, error);
      throw error;
    }
    return lane;
  });
}

export async function auditProjectLanes(
  projectId?: string,
  options: { mobile?: boolean; compact?: boolean } = {},
): Promise<void> {
  const projects = projectId ? [getActiveProject(projectId)] : getActiveProjects();
  const failures: string[] = [];
  for (const project of projects) {
    for (const lane of getProjectLanes(project)) {
      try {
        await verifyProjectLane(project.id, lane.id, options);
      } catch (error) {
        failures.push(
          `${project.id}/${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (failures.length > 0)
    throw new Error(`Project environment audit failed:\n${failures.join("\n")}`);
}

export async function resetProjectLane(
  projectId: string,
  laneId: string,
  options: { beforeReset?: () => Promise<void> } = {},
): Promise<void> {
  const lane = selectProjectLane(getActiveProjects(), { projectId, laneId });
  await options.beforeReset?.();
  await withRegistryLock(async (registry) => {
    const record = recordForLane(registry, lane);
    try {
      await runEnvironmentCommand(lane, registry, "reset");
      await verifyLane(lane, registry, { liveServices: false });
    } catch (error) {
      recordFailure(record, error);
      throw error;
    }
  });
}

export async function destroyProjectLane(
  projectId: string,
  laneId: string,
  confirmed: boolean,
  options: { beforeDestroy?: () => Promise<void> } = {},
): Promise<Lane> {
  if (!confirmed) throw new Error("Pass --confirm to destroy task-environment resources");
  if (laneId === "main") throw new Error("The canonical main environment cannot be destroyed");
  const lane = selectProjectLane(getActiveProjects(), { projectId, laneId });
  await options.beforeDestroy?.();
  return withRegistryLock(async (registry) => {
    if (!existsSync(lane.path)) {
      delete registry.projects[projectId]?.[laneId];
      return lane;
    }
    const record = recordForLane(registry, lane);
    try {
      await runEnvironmentCommand(lane, registry, "destroy");
    } catch (error) {
      recordFailure(record, error);
      throw error;
    }
    delete registry.projects[projectId]?.[laneId];
    return lane;
  });
}

export async function pruneMissingProjectLanes(projectId?: string): Promise<Lane[]> {
  const projects = selectedProjects(projectId);
  return withRegistryLock(async (registry) => {
    const pruned: Lane[] = [];
    for (const project of projects) {
      for (const lane of lanesForRegistry(project, registry)) {
        if (lane.kind !== "task" || existsSync(lane.path)) continue;
        delete registry.projects[project.id]?.[lane.id];
        pruned.push(lane);
      }
    }
    return pruned;
  });
}

function selectedProjects(projectId?: string): ActiveProject[] {
  return projectId ? [getActiveProject(projectId)] : getActiveProjects();
}

function projectSlimmingProfile(
  project: ActiveProject,
  mode: SimulatorSlimmingMode,
): SimulatorSlimmingProfile {
  if (mode === "full") return { exceptCategories: [], keepServices: [] };
  if (!project.simulatorSlimming) {
    throw new Error(`${project.id} has no configured simulator slimming profile`);
  }
  return {
    exceptCategories: project.simulatorSlimming.exceptCategories,
    keepServices: project.simulatorSlimming.keepServices ?? [],
  };
}

async function simSlim(args: string[]): Promise<string> {
  try {
    return (await execa("simslim", args, { env: process.env })).stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT"))
      throw new Error(`SimSlim is unavailable. Run: ${SIMSLIM_INSTALL_COMMAND}`);
    throw new Error(`SimSlim failed: ${message}`);
  }
}

async function simSlimCategories(): Promise<SimSlimCategory[]> {
  assertSupportedSimSlimVersion(await simSlim(["--version"]));
  return parseSimSlimCategories(await simSlim(["profiles", "--json"]));
}

async function configuredSimulator(lane: Lane): Promise<SimulatorDevice> {
  const result = await execa("xcrun", ["simctl", "list", "-j", "devices"], { env: process.env });
  const state = z
    .object({
      devices: z.record(
        z.string(),
        z.array(
          z.object({
            name: z.string(),
            udid: z.string().optional(),
            state: z.string().optional(),
            isAvailable: z.boolean().optional(),
          }),
        ),
      ),
    })
    .parse(JSON.parse(result.stdout));
  const name = simulatorName(lane);
  const simulator = findSimulator(state, name);
  if (!simulator?.udid) throw new Error(`Simulator ${name} is missing`);
  return simulator;
}

async function inspectSimulatorProfile(
  lane: Lane,
  mode: SimulatorSlimmingMode,
  categories: SimSlimCategory[],
  profileOverride?: SimulatorSlimmingProfile,
): Promise<LaneSimulatorSlimmingStatus> {
  const profile = profileOverride ?? projectSlimmingProfile(lane.project, mode);
  const expected = expectedDisabledLabels(categories, profile);
  const simulator = await configuredSimulator(lane);
  const initialState = simulator.state;
  const wasBooted = initialState === "Booted";
  try {
    if (!wasBooted) {
      await execa("xcrun", ["simctl", "boot", simulator.udid!], { env: process.env });
      await execa("xcrun", ["simctl", "bootstatus", simulator.udid!, "-b"], { env: process.env });
    }
    const status = parseSimSlimStatus(
      await simSlim(["status", simulator.udid!, "--dropped", "--json"]),
    );
    let matchesProfile = true;
    try {
      assertSimSlimProfile(categories, status, profile);
      const launchd = await execa("xcrun", [
        "simctl",
        "spawn",
        simulator.udid!,
        "launchctl",
        "print-disabled",
        "system",
      ]);
      assertAlwaysEnabledServices(categories, parseDisabledLaunchdLabels(launchd.stdout));
    } catch {
      matchesProfile = false;
    }
    return {
      project: lane.project.id,
      lane: lane.id,
      simulatorName: simulator.name,
      udid: simulator.udid,
      initialState,
      mode,
      expectedDisabled: expected.length,
      actualDisabled: disabledLabels(status).length,
      matchesProfile,
    };
  } finally {
    if (!wasBooted)
      await execa("xcrun", ["simctl", "shutdown", simulator.udid!], { env: process.env });
  }
}

async function simulatorFleetOperation(
  operation: SimulatorFleetReport["operation"],
  projectId?: string,
  mode: SimulatorSlimmingMode = "project",
): Promise<SimulatorFleetReport> {
  const categories = await simSlimCategories();
  const simulators: LaneSimulatorSlimmingStatus[] = [];
  for (const project of selectedProjects(projectId)) {
    for (const lane of getProjectLanes(project)) {
      const base = { project: project.id, lane: lane.id, simulatorName: simulatorName(lane), mode };
      try {
        const simulator = await configuredSimulator(lane);
        if (operation === "apply") {
          const profile = projectSlimmingProfile(project, mode);
          expectedDisabledLabels(categories, profile);
          await simSlim(simSlimOnArgs(simulator.udid!, profile, true));
        } else if (operation === "restore") {
          await simSlim(simSlimOffArgs(simulator.udid!, true));
        }
        simulators.push(
          operation === "restore"
            ? await inspectSimulatorProfile(lane, mode, categories, {
                exceptCategories: categories.map(({ id }) => id),
                keepServices: [],
              })
            : await inspectSimulatorProfile(lane, mode, categories),
        );
      } catch (error) {
        simulators.push({ ...base, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { operation, simulators };
}

export function statusLaneSimulators(
  projectId?: string,
  mode: SimulatorSlimmingMode = "project",
): Promise<SimulatorFleetReport> {
  return simulatorFleetOperation("status", projectId, mode);
}

export function applyLaneSimulatorSlimming(
  projectId?: string,
  mode: SimulatorSlimmingMode = "project",
): Promise<SimulatorFleetReport> {
  return simulatorFleetOperation("apply", projectId, mode);
}

export function restoreLaneSimulators(projectId?: string): Promise<SimulatorFleetReport> {
  return simulatorFleetOperation("restore", projectId);
}

export function simulatorFleetFailures(
  report: SimulatorFleetReport,
): LaneSimulatorSlimmingStatus[] {
  return report.simulators.filter(({ error, matchesProfile }) => error || matchesProfile === false);
}
