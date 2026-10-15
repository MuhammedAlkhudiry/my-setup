#!/usr/bin/env bun

import { execa } from "execa";
import { join } from "node:path";
import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { agentOutput } from "../lib/agent-output";

interface ProjectResult {
  name: string;
  repo: string;
  runner?: string;
  override?: string | null;
  changed?: boolean;
  error?: string;
}

agentOutput("ci-runner", {
  nativeJson: true,
  summary: (output) => {
    const receipt = JSON.parse(output) as { projects: ProjectResult[] };

    return `ci-runner: ${receipt.projects.map(({ name, runner }) => `${name}=${runner}`).join("; ")}`;
  },
  failures: (output) => {
    const receipt = JSON.parse(output) as { error?: string; projects: ProjectResult[] };

    return receipt.error
      ? [`ci-runner: ${receipt.error}`]
      : receipt.projects.filter(({ error }) => error).map(({ name, error }) => `${name}: ${error}`);
  },
});

const argv = process.argv.slice(2);
const action = argv[0];
const receipt: { action?: string; projects: ProjectResult[]; error?: string; log?: string } = {
  action,
  projects: [],
};

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: ci-runner github|ubicloud|status [--json] [--verbose]
github sets CI_RUNNER=ubuntu-24.04 for every active project.
ubicloud deletes CI_RUNNER, restoring the workflow's Ubicloud default.
status reads the repository variables without changing them.
Existing queued jobs keep their selected runner; dispatch a new main run after switching.
Requires authenticated gh with repository variable write access. Exit: 0 success, 1 failed, 2 invalid input.`);
  process.exit(0);
}

let code = 0;

try {
  if (
    !["github", "ubicloud", "status"].includes(action) ||
    argv.slice(1).some((arg) => arg !== "--json")
  ) {
    code = 2;
    throw new Error("Pass github, ubicloud, or status; see --help");
  }

  const gh = async (args: string[]) => {
    const result = await execa("gh", args, { reject: false, timeout: 30_000 });

    if (result.failed) throw new Error(result.stderr.trim() || result.shortMessage);

    return result.stdout;
  };
  const read = async (repo: string): Promise<string | undefined> => {
    const variables = JSON.parse(
      await gh(["variable", "list", "--repo", repo, "--json", "name,value"]),
    ) as { name: string; value: string }[];

    return variables.find(({ name }) => name === "CI_RUNNER")?.value;
  };

  // Read every repository before any write, so an access failure cannot silently switch only one project.
  for (const project of ACTIVE_PROJECTS) {
    const url = new URL(project.remoteUrl);
    if (url.hostname !== "github.com" || !/^\/[\w.-]+\/[\w.-]+\.git$/.test(url.pathname))
      throw new Error(`Unsupported GitHub remote for ${project.name}`);

    const repo = url.pathname.slice(1, -4);
    const result: ProjectResult = { name: project.name, repo };
    receipt.projects.push(result);

    try {
      result.override = (await read(repo)) ?? null;
      result.runner = result.override || "ubicloud-standard-2";
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      code = 1;
    }
  }

  if (code === 0 && action !== "status") {
    for (const result of receipt.projects) {
      try {
        // Re-read before mutation: absence and an empty variable have the same effective runner,
        // but restoration must delete either an empty or nonempty repository override.
        const current = await read(result.repo);
        const desired = action === "github" ? "ubuntu-24.04" : undefined;
        result.changed = false;

        if (current !== desired) {
          await gh(
            action === "github"
              ? ["variable", "set", "CI_RUNNER", "--repo", result.repo, "--body", desired!]
              : ["variable", "delete", "CI_RUNNER", "--repo", result.repo],
          );
          result.changed = true;
          result.runner = undefined;
          result.override = undefined;
        }

        const actual = await read(result.repo);
        result.override = actual ?? null;
        result.runner = actual || "ubicloud-standard-2";
        if (actual !== desired)
          throw new Error(`CI_RUNNER verification failed: ${actual ?? "unset"}`);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        code = 1;
      }
    }
  }
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  code ||= 1;
}

if (code) receipt.log = join(process.env.MY_SETUP_OUTPUT_LOG_ROOT!, "full.log");

console.log(JSON.stringify({ status: code ? "failed" : "success", ...receipt }));
process.exitCode = code;
