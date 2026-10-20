import { expect, test } from "bun:test";
import {
  collectSystemToolStatuses,
  systemToolStatusLabel,
  type SystemToolGroup,
} from "./system-tools";

test("system tool probes stay bounded across groups and preserve ordered results", async () => {
  const groups: SystemToolGroup[] = Array.from({ length: 2 }, (_, group) => ({
    title: String(group),
    tools: Array.from({ length: 4 }, (_, tool) => ({
      name: `tool-${group}-${tool}`,
      level: "required",
      why: "test",
      versionArgs: ["--version"],
      latest: { type: "command", command: "registry", args: [] },
      update: {},
    })),
  }));
  let active = 0;
  let peak = 0;
  const calls: { command: string; timeout: number }[] = [];
  const result = await collectSystemToolStatuses(groups, async (command, args, timeout) => {
    active++;
    peak = Math.max(peak, active);
    calls.push({ command, timeout });
    await Promise.resolve();
    active--;

    return {
      stdout: command === "zsh" ? `/bin/${args[1].split(" ").at(-1)}` : "1.2.3\n",
      stderr: "",
      exitCode: 0,
    };
  });

  expect(peak).toBeLessThanOrEqual(3);
  expect(calls).toHaveLength(24);
  expect(
    calls.filter((call) => call.command === "registry").every((call) => call.timeout === 30_000),
  ).toBe(true);
  expect(
    calls.filter((call) => call.command !== "registry").every((call) => call.timeout === 15_000),
  ).toBe(true);
  expect(result.map((group) => group.tools.map((status) => status.tool.name))).toEqual(
    groups.map((group) => group.tools.map((tool) => tool.name)),
  );
  expect(
    result
      .flatMap((group) => group.tools)
      .every((status) => systemToolStatusLabel(status) === "current"),
  ).toBe(true);
});

test("timeouts remain distinct from missing tools and failed versions in every probe phase", async () => {
  const names = ["path-timeout", "version-timeout", "latest-timeout", "missing", "broken"];
  const [group] = await collectSystemToolStatuses(
    [
      {
        title: "probes",
        tools: names.map((name) => ({
          name,
          level: "required",
          why: "test",
          versionArgs: ["--version"],
          latest: { type: "command", command: "registry", args: [name] },
          update: {},
        })),
      },
    ],
    async (command, args) => {
      const name =
        command === "zsh"
          ? args[1].split(" ").at(-1)
          : command === "registry"
            ? args[0]
            : command.slice(5);
      const timedOut =
        (command === "zsh" && name === "path-timeout") ||
        (command.startsWith("/bin/") && name === "version-timeout") ||
        (command === "registry" && name === "latest-timeout");
      const failed =
        timedOut ||
        (command === "zsh" && name === "missing") ||
        (command.startsWith("/bin/") && name === "broken");

      return {
        stdout: failed ? "" : command === "zsh" ? `/bin/${name}` : "1.2.3",
        stderr: "",
        exitCode: failed ? 1 : 0,
        timedOut,
      };
    },
  );
  const [path, version, latest, missing, broken] = group.tools;

  expect(path.probeError).toBe("probe timed out");
  expect(systemToolStatusLabel(path)).toBe("unknown");
  expect(version.path).toBe("/bin/version-timeout");
  expect(version.versionError).toBe("probe timed out");
  expect(systemToolStatusLabel(version)).toBe("unknown");
  expect(latest.current).toBe("1.2.3");
  expect(latest.latestError).toBe("probe timed out");
  expect(latest.versionError).toBeUndefined();
  expect(systemToolStatusLabel(latest)).toBe("unknown");
  expect(missing.probeError).toBeUndefined();
  expect(systemToolStatusLabel(missing)).toBe("required");
  expect(broken.versionError).toBe("probe failed");
  expect(systemToolStatusLabel(broken)).toBe("unknown");
});
