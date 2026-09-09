import { readFileSync } from "node:fs";

import { z } from "zod";

const simulatorSlimmingProfileSchema = z.object({
  exceptCategories: z.array(z.string().min(1)),
  keepServices: z.array(z.string().min(1)).optional(),
});

const laneServiceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  directory: z.string().min(1),
  runner: z.discriminatedUnion("type", [
    z.object({ type: z.literal("bun-script"), script: z.string().min(1) }),
    z.object({ type: z.literal("npm-script"), script: z.string().min(1) }),
    z.object({ type: z.literal("artisan"), command: z.string().min(1) }),
  ]),
});

const mobileDevelopmentSchema = z.object({
  directory: z.string().min(1),
  bundleIdentifier: z.string().min(1),
  developmentScheme: z.string().min(1).optional(),
});

const projectFields = {
  id: z.string().min(1),
  name: z.string().min(1),
  remoteUrl: z.string().url(),
  baseBranch: z.string().min(1),
  canonicalRoot: z.string().min(1),
  environmentVariable: z.string().min(1),
  services: z.array(laneServiceSchema).min(1),
  mobile: mobileDevelopmentSchema.optional(),
  simulatorSlimming: simulatorSlimmingProfileSchema.optional(),
};

export const activeProjectSchema = z.object(projectFields).superRefine(validateProject);

const lanesConfigSchema = z.object({
  version: z.literal(5),
  projects: z.array(activeProjectSchema),
});

export interface ActiveProject {
  id: string;
  name: string;
  remoteUrl: string;
  baseBranch: string;
  canonicalRoot: string;
  environmentVariable: string;
  services: LaneServiceDefinition[];
  mobile?: MobileDevelopment;
  simulatorSlimming?: SimulatorSlimmingProfile;
}

export interface MobileDevelopment {
  directory: string;
  bundleIdentifier: string;
  developmentScheme?: string;
}

export interface LaneServiceDefinition {
  id: string;
  name: string;
  directory: string;
  runner:
    | { type: "bun-script"; script: string }
    | { type: "npm-script"; script: string }
    | { type: "artisan"; command: string };
}

export interface SimulatorSlimmingProfile {
  exceptCategories: string[];
  keepServices?: string[];
}

export interface LanesConfig {
  version: 5;
  projects: ActiveProject[];
}

export function createLanesConfig(projects: ActiveProject[]): LanesConfig {
  return lanesConfigSchema.parse({ version: 5, projects });
}

export function readLanesConfig(path: string): LanesConfig {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return lanesConfigSchema.parse(value);
}

function validateProject(
  { services }: { services: LaneServiceDefinition[] },
  context: z.RefinementCtx,
): void {
  if (new Set(services.map(({ id }) => id)).size !== services.length) {
    context.addIssue({ code: "custom", message: "Lane service ids must be unique" });
  }
}
