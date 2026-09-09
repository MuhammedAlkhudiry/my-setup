import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { createLanesConfig, readLanesConfig, type ActiveProject } from "./lanes-config";

const project: ActiveProject = {
  id: "project",
  name: "Project",
  remoteUrl: "https://example.com/project.git",
  baseBranch: "main",
  canonicalRoot: "/projects/project",
  environmentVariable: "PROJECT_LANE_ROOT",
  services: [
    {
      id: "frontend",
      name: "Frontend",
      directory: "app",
      runner: { type: "bun-script", script: "dev" },
    },
  ],
};

test("creates a static project catalog without task environments", () => {
  expect(createLanesConfig([project])).toEqual({ version: 5, projects: [project] });
});

test("reads the current catalog and rejects unsupported versions", () => {
  const root = mkdtempSync(join(tmpdir(), "lanes-config-"));
  const path = join(root, "projects.json");
  try {
    writeFileSync(path, JSON.stringify({ version: 5, projects: [project] }));
    expect(readLanesConfig(path)).toEqual({ version: 5, projects: [project] });
    for (const version of [3, 4, 6]) {
      writeFileSync(path, JSON.stringify({ version, projects: [project] }));
      expect(() => readLanesConfig(path)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate service ids", () => {
  expect(() =>
    createLanesConfig([{ ...project, services: [project.services[0]!, project.services[0]!] }]),
  ).toThrow("Lane service ids must be unique");
});
