import { expect, test } from "bun:test";

import { ACTIVE_PROJECTS } from "./active-projects";

test("declares a unique id, remote, and canonical clone for every active project", () => {
  const ids = ACTIVE_PROJECTS.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);

  for (const project of ACTIVE_PROJECTS) {
    expect(project.remoteUrl).toMatch(/^https:\/\/github\.com\/.+\.git$/);
    expect(project.canonicalRoot.startsWith("/")).toBe(true);
    expect(project.baseBranch.length).toBeGreaterThan(0);
  }
});
