import { spawnSync } from "node:child_process";

import type { ProjectEnvironmentContext, RunOptions } from "./types";

export function log(step: string, message: string): void {
  console.log(`[project-lane:${step}] ${message}`);
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(quote).join(" ");
}

function execute(
  context: ProjectEnvironmentContext,
  step: string,
  command: string,
  args: string[],
  options: RunOptions,
) {
  log(step, commandLine(command, args));
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      PATH: `${context.herdBin}:${process.env.PATH ?? ""}`,
      PWD: options.cwd,
      ...options.env,
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stderr) console.error(result.stderr.trimEnd());
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${commandLine(command, args)} failed (${result.status ?? 1})`);
  }
  return result;
}

export function run(
  context: ProjectEnvironmentContext,
  step: string,
  command: string,
  args: string[],
  options: RunOptions,
): void {
  const result = execute(context, step, command, args, options);
  if (result.stdout) console.log(result.stdout.trimEnd());
}

export function output(
  context: ProjectEnvironmentContext,
  step: string,
  command: string,
  args: string[],
  options: RunOptions,
): string {
  return execute(context, step, command, args, options).stdout;
}
