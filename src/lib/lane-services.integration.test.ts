import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("controls and reads logs for a launchd-backed lane service", async () => {
  const root = mkdtempSync(join(tmpdir(), "lanes-services-"));
  roots.push(root);
  const lanePath = join(root, "project-lane-1");
  const appPath = join(lanePath, "app");
  const configPath = join(root, "projects.json");
  const statePath = join(root, "state.json");
  const stateHome = join(root, "state-home");
  mkdirSync(appPath, { recursive: true });
  writeFileSync(
    join(appPath, "package.json"),
    JSON.stringify({
      scripts: {
        dev: 'printf "\\033[31mservice-ready:$EXPO_DEV_SERVER_PORT\\r\\n"; sleep 30 #',
      },
    }),
  );
  writeFileSync(join(appPath, ".env.local"), "EXPO_DEV_SERVER_PORT=9123\n");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 5,
      projects: [
        {
          id: "service-test",
          name: "Service Test",
          remoteUrl: "https://example.com/project.git",
          baseBranch: "main",
          canonicalRoot: join(root, "canonical-project"),
          environmentVariable: "SERVICE_TEST_ROOT",
          services: [
            {
              id: "frontend",
              name: "Frontend",
              directory: "app",
              runner: { type: "bun-script", script: "dev" },
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 2,
      projects: {
        "service-test": {
          "lane-1": { path: lanePath, number: 1, kind: "task" },
        },
      },
    }),
  );

  const run = (args: string[]) =>
    Bun.spawnSync(["bun", "src/commands/lanes-cli.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LANES_CONFIG_PATH: configPath,
        XDG_STATE_HOME: stateHome,
        LANES_STATE_PATH: statePath,
        LANES_STATE_LOCK_PATH: `${statePath}.lock`,
      },
    });

  try {
    const started = run(["services", "start", "service-test", "lane-1", "frontend", "--json"]);
    expect(started.exitCode).toBe(0);
    const startedService = JSON.parse(started.stdout.toString()).lanes[0].services[1];
    expect(startedService.state).toBe("running");
    expect(startedService.residentBytes).toBeGreaterThan(0);

    // A running process may not have read its package script or emitted output yet.
    const logDeadline = Date.now() + 5_000;
    let initialLog = "";
    do {
      initialLog = await Bun.file(startedService.logPath).text();
      if (initialLog.includes("service-ready:9123")) break;
      await Bun.sleep(25);
    } while (Date.now() < logDeadline);
    expect(initialLog).toContain("service-ready:9123");

    const sourcePath = join(appPath, "src", "feature.ts");
    mkdirSync(join(appPath, "src"), { recursive: true });
    writeFileSync(sourcePath, "export const feature = true;\n");
    const sourceChanged = run(["services", "status", "service-test", "lane-1", "--json"]);
    expect(JSON.parse(sourceChanged.stdout.toString()).lanes[0].services[1].state).toBe("running");

    writeFileSync(
      join(appPath, "package.json"),
      JSON.stringify({ scripts: { dev: "echo service-updated; sleep 30 #" } }),
    );
    const stale = run(["services", "status", "service-test", "lane-1", "--json"]);
    expect(JSON.parse(stale.stdout.toString()).lanes[0].services[1]).toMatchObject({
      state: "degraded",
      detail: "Service inputs changed after launch; restart this lane service",
    });

    const restarted = run(["services", "restart", "service-test", "lane-1", "frontend", "--json"]);
    expect(JSON.parse(restarted.stdout.toString()).lanes[0].services[1].state).toBe("running");

    writeFileSync(join(appPath, ".env.local"), "EXPO_DEV_SERVER_PORT=9124\n");
    const portChanged = run(["services", "status", "service-test", "lane-1", "--json"]);
    expect(JSON.parse(portChanged.stdout.toString()).lanes[0].services[1]).toMatchObject({
      state: "degraded",
      detail: "Service inputs changed after launch; restart this lane service",
    });
    const portRestarted = run([
      "services",
      "restart",
      "service-test",
      "lane-1",
      "frontend",
      "--json",
    ]);
    expect(JSON.parse(portRestarted.stdout.toString()).lanes[0].services[1].state).toBe("running");

    const logs = run(["services", "logs", "service-test", "lane-1", "frontend", "--lines", "10"]);
    expect(logs.exitCode).toBe(0);
    expect(logs.stdout.toString()).toContain("service-ready:9123");
    expect(logs.stdout.toString()).not.toContain("\u001b[31m");
    expect(logs.stdout.toString()).not.toContain("\r");

    const rawLogs = run([
      "services",
      "logs",
      "service-test",
      "lane-1",
      "frontend",
      "--lines",
      "10",
      "--raw",
    ]);
    expect(rawLogs.exitCode).toBe(0);
    expect(rawLogs.stdout.toString()).toContain("\u001b[31mservice-ready:9123\r");
  } finally {
    const stopped = run(["services", "stop", "service-test", "lane-1", "frontend", "--json"]);
    expect(stopped.exitCode).toBe(0);
    const services = JSON.parse(stopped.stdout.toString()).lanes[0].services;
    expect(services[0]).toMatchObject({
      id: "site",
      state: "stopped",
      detail: "Frontend is stopped",
    });
    expect(services[1].state).toBe("stopped");
    expect(services[1].residentBytes).toBeUndefined();
  }
}, 20_000);

test("controls every lane and service in a project", () => {
  const root = mkdtempSync(join(tmpdir(), "lanes-service-fleet-"));
  roots.push(root);
  const configPath = join(root, "projects.json");
  const statePath = join(root, "state.json");
  const stateHome = join(root, "state-home");
  const lanes = [1, 2].map((number) => {
    const lanePath = join(root, `project-lane-${number}`);
    const appPath = join(lanePath, "app");
    mkdirSync(appPath, { recursive: true });
    writeFileSync(
      join(appPath, "package.json"),
      JSON.stringify({ scripts: { dev: `echo fleet-ready:${number}; sleep 30 #` } }),
    );
    return { number, path: lanePath };
  });
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 5,
      projects: [
        {
          id: "service-fleet",
          name: "Service Fleet",
          remoteUrl: "https://example.com/project.git",
          baseBranch: "main",
          canonicalRoot: lanes[0]!.path,
          environmentVariable: "SERVICE_FLEET_ROOT",
          services: [
            {
              id: "frontend",
              name: "Frontend",
              directory: "app",
              runner: { type: "bun-script", script: "dev" },
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 2,
      projects: {
        "service-fleet": {
          main: { path: lanes[0]!.path, number: 0, kind: "canonical" },
          second: { path: lanes[1]!.path, number: 1, kind: "task" },
        },
      },
    }),
  );

  const run = (args: string[]) =>
    Bun.spawnSync(["bun", "src/commands/lanes-cli.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LANES_CONFIG_PATH: configPath,
        XDG_STATE_HOME: stateHome,
        LANES_STATE_PATH: statePath,
        LANES_STATE_LOCK_PATH: `${statePath}.lock`,
      },
    });

  try {
    const started = run(["services", "start", "service-fleet", "all", "all", "--json"]);
    expect(started.exitCode).toBe(0);
    const statuses = JSON.parse(started.stdout.toString()).lanes;
    expect(statuses).toHaveLength(2);
    expect(
      statuses.every(
        ({ services }: { services: { state: string }[] }) => services[1]?.state === "running",
      ),
    ).toBe(true);
  } finally {
    const stopped = run(["services", "stop", "service-fleet", "all", "all", "--json"]);
    expect(stopped.exitCode).toBe(0);
    const statuses = JSON.parse(stopped.stdout.toString()).lanes;
    expect(
      statuses.every(
        ({ services }: { services: { state: string }[] }) => services[1]?.state === "stopped",
      ),
    ).toBe(true);
  }
}, 60_000);

test("waits for Metro to become ready before failing startup", () => {
  const root = mkdtempSync(join(tmpdir(), "lanes-service-metro-"));
  roots.push(root);
  const lanePath = join(root, "project-lane-1");
  const appPath = join(lanePath, "app");
  const configPath = join(root, "projects.json");
  const statePath = join(root, "state.json");
  const stateHome = join(root, "state-home");
  mkdirSync(appPath, { recursive: true });
  writeFileSync(
    join(appPath, "package.json"),
    JSON.stringify({ scripts: { start: "bun metro-server.ts" } }),
  );
  writeFileSync(join(appPath, ".env.local"), "EXPO_DEV_SERVER_PORT=9124\n");
  writeFileSync(
    join(appPath, "metro-server.ts"),
    `await Bun.sleep(1_800);
Bun.serve({
  port: Number(process.env.EXPO_DEV_SERVER_PORT),
  fetch: () => new Response("packager-status:running"),
});
`,
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 5,
      projects: [
        {
          id: "service-metro",
          name: "Service Metro",
          remoteUrl: "https://example.com/project.git",
          baseBranch: "main",
          canonicalRoot: join(root, "canonical-project"),
          environmentVariable: "SERVICE_METRO_ROOT",
          services: [
            {
              id: "metro",
              name: "Metro",
              directory: "app",
              runner: { type: "bun-script", script: "start" },
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 2,
      projects: {
        "service-metro": {
          "lane-1": { path: lanePath, number: 1, kind: "task" },
        },
      },
    }),
  );

  const run = (args: string[]) =>
    Bun.spawnSync(["bun", "src/commands/lanes-cli.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LANES_CONFIG_PATH: configPath,
        XDG_STATE_HOME: stateHome,
        LANES_STATE_PATH: statePath,
        LANES_STATE_LOCK_PATH: `${statePath}.lock`,
      },
    });

  try {
    const started = run(["services", "start", "service-metro", "lane-1", "metro", "--json"]);
    expect(started.exitCode).toBe(0);
    expect(JSON.parse(started.stdout.toString()).lanes[0].services[1].state).toBe("running");
  } finally {
    const stopped = run(["services", "stop", "service-metro", "lane-1", "metro", "--json"]);
    expect(stopped.exitCode).toBe(0);
  }
}, 20_000);
