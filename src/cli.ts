#!/usr/bin/env bun

import { join } from "node:path";

import { cac } from "cac";
import { execa } from "execa";

import { install } from "./commands/install";

const ROOT_DIR = join(import.meta.dir, "..");

async function runScript(command: string, args: string[], compact = false): Promise<void> {
  const result = await execa(command, args, {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: compact ? "pipe" : "inherit",
    reject: false,
  });
  if (result.exitCode === 0) return;
  if (compact) {
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
  }
  throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.exitCode}`);
}

const cli = cac("my-setup");

cli
  .command("install", "Install generated rules, config, skills, and shell helpers locally")
  .option("--compact", "Print only warnings, failures, and the final result")
  .action(async (options: { compact?: boolean }) => {
    await install();
    await runScript("zsh", [join(ROOT_DIR, "shell", "doctor.zsh")], options.compact);
    if (options.compact) console.log("my-setup install: ok");
  });

cli.help();
cli.addEventListener("command:*", () => {
  console.error(`Unknown command: ${cli.args.join(" ")}`);
  process.exitCode = 1;
});
cli.parse();
