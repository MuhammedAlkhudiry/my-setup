import { expect, test } from "bun:test";

import {
  agentSignoff,
  chooseAgentSignoffHost,
  localizeLogs,
} from "./agent-signoff";

const request = {
  repo: "owner/repo",
  branch: "feature",
  sha: "a".repeat(40),
  args: ["--full"],
};

function io(overrides: Partial<Parameters<typeof agentSignoff>[1]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    io: {
      spares: ["big-mac", "small-mac"],
      probe: async (host: string) => ({
        host,
        load: host === "big-mac" ? 8 : 2,
        maxLoad: 10,
      }),
      remote: async (host: string) => {
        calls.push(`remote ${host}`);
        return { exitCode: 0, output: "ok", logs: {} };
      },
      local: async (args: string[]) => {
        calls.push(`local ${args.join(" ")}`);
        return { exitCode: 0, output: "ok" };
      },
      ...overrides,
    },
  };
}

test("the least-loaded idle spare wins, as in the queue", () => {
  expect(
    chooseAgentSignoffHost([
      { host: "big-mac", load: 8, maxLoad: 10 },
      { host: "small-mac", load: 2, maxLoad: 10 },
    ]),
  ).toBe("small-mac");
  expect(
    chooseAgentSignoffHost([
      { host: "small-mac", load: 2, maxLoad: 10, busy: true },
      { host: "big-mac", load: 9, maxLoad: 10 },
    ]),
  ).toBe("big-mac");
});

test("with every spare Mac over its limit, a spare Mac still runs it, the least loaded for its size", () => {
  expect(
    chooseAgentSignoffHost([
      { host: "big-mac", load: 30, maxLoad: 16 },
      { host: "small-mac", load: 12, maxLoad: 10 },
    ]),
  ).toBe("small-mac");
  expect(
    chooseAgentSignoffHost([
      { host: "small-mac", load: 11, maxLoad: 10, busy: true },
      { host: "big-mac", load: 200, maxLoad: 16 },
    ]),
  ).toBe("big-mac");
  expect(chooseAgentSignoffHost([{ host: "big-mac", load: 200, maxLoad: 16, busy: true }])).toBe(
    "big-mac",
  );
  expect(chooseAgentSignoffHost([])).toBeUndefined();
});

test("every spare Mac over its limit still runs remotely, never on main-mac", async () => {
  const { calls, io: deps } = io({
    probe: async (host) => ({ host, load: host === "big-mac" ? 40 : 25, maxLoad: 10 }),
  });
  const run = await agentSignoff(request, deps);

  expect(run.host).toBe("small-mac");
  expect(calls).toEqual(["remote small-mac"]);
});

test("runs on the chosen spare Mac", async () => {
  const { calls, io: deps } = io();
  const run = await agentSignoff(request, deps);

  expect(run.host).toBe("small-mac");
  expect(calls).toEqual(["remote small-mac"]);
});

test("a failed spare falls to the next one, then runs here", async () => {
  const { calls, io: deps } = io({
    remote: async (host) => {
      calls.push(`remote ${host}`);
      throw new Error("prepare failed");
    },
  });
  const run = await agentSignoff(request, deps);

  expect(calls).toEqual(["remote small-mac", "remote big-mac", "local --full"]);
  expect(run.host).toBe("main-mac");
  expect(run.notes.join("; ")).toContain("small-mac failed");
});

test("no reachable spare runs here and never refuses", async () => {
  const { calls, io: deps } = io({
    probe: async (host) => {
      throw new Error(`unreachable ${host}`);
    },
  });
  const run = await agentSignoff(request, deps);

  expect(calls).toEqual(["local --full"]);
  expect(run.notes).toEqual(["big-mac unreachable", "small-mac unreachable", "no spare Mac reachable"]);
});

test("no configured spare runs here", async () => {
  const { calls, io: deps } = io({ spares: [] });

  expect((await agentSignoff(request, deps)).host).toBe("main-mac");
  expect(calls).toEqual(["local --full"]);
});

test("a completed failing run is the result, not a reason to try elsewhere", async () => {
  const { calls, io: deps } = io({
    remote: async (host) => {
      calls.push(`remote ${host}`);
      return {
        exitCode: 1,
        output: "FAIL backend:test log=/remote/a.log",
        logs: {},
      };
    },
  });
  const run = await agentSignoff(request, deps);

  expect(run.exitCode).toBe(1);
  expect(calls).toEqual(["remote small-mac"]);
});

test("remote log paths become local copies, longest path first", () => {
  const { output, files } = localizeLogs(
    "FAIL a log=/r/run.log.check.log",
    {
      "/r/run.log": "see log=/r/run.log.check.log",
      "/r/run.log.check.log": "boom",
    },
    "/l/x",
  );

  expect(output).toBe("FAIL a log=/l/x-1.log");
  expect(files).toEqual([
    { path: "/l/x-0.log", content: "see log=/l/x-1.log" },
    { path: "/l/x-1.log", content: "boom" },
  ]);
});
