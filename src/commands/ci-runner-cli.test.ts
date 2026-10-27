import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ACTIVE_PROJECTS } from "../../config/active-projects";

test.each(["status", "switch", "restore", "read failure", "write failure", "invalid input"])(
  "ci-runner %s",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "ci-runner-test-"));
    const bin = join(root, "bin");
    const statePath = join(root, "state.json");
    const cli = new URL("./ci-runner-cli.ts", import.meta.url).pathname;
    const repos = ACTIVE_PROJECTS.map(({ remoteUrl }) => new URL(remoteUrl).pathname.slice(1, -4));
    const logs: string[] = [];
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const path = process.env.CI_RUNNER_TEST_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const repo = args[args.indexOf("--repo") + 1];
const op = args[1];
state.calls.push({repo, op});
writeFileSync(path, JSON.stringify(state));
if ((state.failRead === repo && op === "list") || (state.failWrite === repo && op !== "list")) {
  console.error("HTTP 403: access denied"); process.exit(1);
}
if (op === "list") {
  console.log(JSON.stringify(state.values[repo] === undefined ? [] : [{name:"CI_RUNNER",value:state.values[repo]}]));
} else if (op === "set") {
  if (args[2] !== "CI_RUNNER") process.exit(2);
  state.values[repo] = args[args.indexOf("--body") + 1];
} else if (op === "delete") {
  if (args[2] !== "CI_RUNNER" || state.values[repo] === undefined) process.exit(2);
  delete state.values[repo];
} else process.exit(2);
writeFileSync(path, JSON.stringify(state));
`,
      { mode: 0o700 },
    );
    const reset = (values: Record<string, string> = {}, failure = {}) =>
      writeFileSync(statePath, JSON.stringify({ values, calls: [], ...failure }));
    const state = () =>
      JSON.parse(readFileSync(statePath, "utf8")) as {
        values: Record<string, string>;
        calls: { repo: string; op: string }[];
      };
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CI_RUNNER_TEST_STATE: statePath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      if (args.includes("--json")) {
        const receipt = JSON.parse(output);
        if (receipt.log) logs.push(receipt.log);
      } else {
        const log = errors.match(/; log: (.+)/)?.[1];
        if (log) logs.push(log);
      }

      return { output, errors, code };
    };

    try {
      if (scenario === "status") {
        reset();
        const status = await run("status");
        expect(status.code).toBe(0);
        expect(status.errors).toBe("");
        expect(status.output.trim().split("\n")).toHaveLength(1);
        expect(state().calls.every(({ op }) => op === "list")).toBe(true);
      }
      if (scenario === "switch") {
        reset();
        const switched = await run("github", "--json");
        expect(switched.code).toBe(0);
        expect(
          JSON.parse(switched.output).projects.every((p: { changed: boolean }) => p.changed),
        ).toBe(true);
        expect(state().values).toEqual(
          Object.fromEntries(repos.map((repo) => [repo, "ubuntu-24.04"])),
        );
        const sets = state().calls.filter(({ op }) => op === "set").length;
        expect((await run("github")).code).toBe(0);
        expect(state().calls.filter(({ op }) => op === "set")).toHaveLength(sets);
      }
      if (scenario === "restore") {
        // Empty overrides must be deleted too; a missing one must not cause a failing delete.
        reset({ [repos[0]]: "" });
        const restored = await run("ubicloud", "--verbose");
        expect(restored.code).toBe(0);
        expect(state().values).toEqual({});
        expect(state().calls.filter(({ op }) => op === "delete")).toEqual([
          { repo: repos[0], op: "delete" },
        ]);
        expect((await run("ubicloud")).code).toBe(0);
      }
      if (scenario === "read failure") {
        reset({}, { failRead: repos[1] });
        const denied = await run("github", "--json");
        expect(denied.code).toBe(1);
        expect(state().calls.every(({ op }) => op === "list")).toBe(true);
        expect(JSON.parse(denied.output).projects[1].error).toContain("403");
        expect(denied.errors).toContain("log:");
        expect(denied.errors).not.toContain("ubicloud-standard-2");
      }
      if (scenario === "write failure") {
        reset({}, { failWrite: repos[1] });
        const partial = await run("github", "--json");
        expect(partial.code).toBe(1);
        expect(state().values).toEqual({ [repos[0]]: "ubuntu-24.04" });
        expect(JSON.parse(partial.output).projects[0].runner).toBe("ubuntu-24.04");
        expect(partial.errors.trim().split("\n")).toHaveLength(1);
        expect(partial.errors).not.toContain(ACTIVE_PROJECTS[0].name);
      }
      if (scenario === "invalid input") {
        reset();
        expect((await run("github", "--bogus", "--json")).code).toBe(2);
        expect(state().calls).toEqual([]);
      }
    } finally {
      for (const log of logs) rmSync(dirname(log), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
