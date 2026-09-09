import { join } from "node:path";

import type { ActiveProject } from "../src/lib/lanes-config";
import type {
  ProjectEnvironmentAdapter,
  ProjectEnvironmentDefinition,
} from "../src/lib/project-environment/types";

const projectsRoot = "/Users/muhammed/PhpstormProjects";

interface ProjectDefinition extends ActiveProject {
  environment: Pick<
    ProjectEnvironmentDefinition,
    "backendDirectory" | "metroPortBase" | "vitePortBase" | "assetUrl" | "phpVersion"
  >;
  loadEnvironmentAdapter: () => Promise<{ adapter: ProjectEnvironmentAdapter }>;
}

export const PROJECT_DEFINITIONS: ProjectDefinition[] = [
  {
    id: "awraq",
    name: "Awraq",
    remoteUrl: "https://github.com/MuhammedAlkhudiry/awraq-project.git",
    baseBranch: "main",
    canonicalRoot: join(projectsRoot, "awraq-project"),
    environmentVariable: "AWRAQ_LANE_ROOT",
    mobile: {
      directory: "awraq-mobile-app",
      bundleIdentifier: "com.awraq",
      developmentScheme: "exp+awraq",
    },
    services: [
      {
        id: "frontend",
        name: "Frontend",
        directory: "family-tree",
        runner: { type: "bun-script", script: "dev" },
      },
      {
        id: "metro",
        name: "Metro",
        directory: "awraq-mobile-app",
        runner: { type: "bun-script", script: "start" },
      },
      {
        id: "horizon",
        name: "Horizon",
        directory: "family-tree",
        runner: { type: "artisan", command: "horizon" },
      },
    ],
    simulatorSlimming: {
      exceptCategories: ["icloud", "store", "web", "pim", "photos", "connectivity"],
    },
    environment: {
      backendDirectory: "family-tree",
      metroPortBase: 8200,
      vitePortBase: 5200,
    },
    loadEnvironmentAdapter: () => import("../src/lib/project-environment/projects/awraq"),
  },
  {
    id: "harium",
    name: "Harium",
    remoteUrl: "https://github.com/MuhammedAlkhudiry/harium-project.git",
    baseBranch: "main",
    canonicalRoot: join(projectsRoot, "harium-project"),
    environmentVariable: "HARIUM_LANE_ROOT",
    mobile: {
      directory: "harium-app",
      bundleIdentifier: "com.muhammed28.harium-app",
      developmentScheme: "myapp",
    },
    services: [
      {
        id: "android-api",
        name: "Android API",
        directory: "harium",
        runner: { type: "bun-script", script: "dev:android-api" },
      },
      {
        id: "frontend",
        name: "Frontend",
        directory: "harium",
        runner: { type: "bun-script", script: "dev" },
      },
      {
        id: "metro",
        name: "Metro",
        directory: "harium-app",
        runner: { type: "bun-script", script: "start" },
      },
      {
        id: "horizon",
        name: "Horizon",
        directory: "harium",
        runner: { type: "artisan", command: "horizon" },
      },
    ],
    simulatorSlimming: {
      exceptCategories: ["icloud", "store", "connectivity", "photos"],
    },
    environment: {
      backendDirectory: "harium",
      metroPortBase: 9300,
      vitePortBase: 5300,
      assetUrl: (bucket) => `https://minio.herd.test/${bucket}`,
    },
    loadEnvironmentAdapter: () => import("../src/lib/project-environment/projects/harium"),
  },
];

export const ACTIVE_PROJECTS: ActiveProject[] = PROJECT_DEFINITIONS.map(
  ({ environment: _environment, loadEnvironmentAdapter: _loadEnvironmentAdapter, ...project }) =>
    project,
);

export function getProjectDefinition(projectId: string): ProjectDefinition {
  const project = PROJECT_DEFINITIONS.find(({ id }) => id === projectId);
  if (!project) throw new Error(`No central project definition for ${projectId}`);
  return project;
}

export function getProjectEnvironmentDefinition(projectId: string): ProjectEnvironmentDefinition {
  const project = getProjectDefinition(projectId);
  if (!project.mobile) throw new Error(`${project.name} has no mobile environment definition`);
  return {
    id: project.id,
    name: project.name,
    rootEnvironmentVariable: project.environmentVariable,
    backendDirectory: project.environment.backendDirectory,
    mobileDirectory: project.mobile.directory,
    metroPortBase: project.environment.metroPortBase,
    vitePortBase: project.environment.vitePortBase,
    defaultRoot: process.cwd(),
    assetUrl: project.environment.assetUrl,
    phpVersion: project.environment.phpVersion,
  };
}
