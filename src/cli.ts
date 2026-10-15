#!/usr/bin/env bun

import { agentOutput, parseCli } from "./lib/agent-output";
import { join } from "node:path";

import { cac } from "cac";
import { execa } from "execa";

import { install } from "./commands/install";

agentOutput("my-setup", {
  summary: (output) => output.trim().split("\n").at(-1) || "my-setup: ok",
  failures: (_output, errors) =>
    errors.split("\n").filter((line) => /^(?:ERROR:|error:|.*; log:)/.test(line)),
});

const ROOT_DIR = join(import.meta.dir, "..");

async function runScript(command: string, args: string[], compact = true): Promise<void> {
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
  .option("--compact", "Use minimal output (the default)")
  .option("--json", "Emit structured results")
  .option("--verbose", "Print details")
  .action(async (options: { compact?: boolean }) => {
    const profile = await install();
    // `doctor` is part of the zsh layer, so only profiles with that layer run it.
    if (profile.shell) {
      await runScript(
        "zsh",
        [join(ROOT_DIR, "shell", "doctor.zsh"), "--verbose"],
        options.compact ?? process.env.MY_SETUP_OUTPUT !== "verbose",
      );
    }
    console.log("my-setup install: ok");
  });

cli.help();
parseCli(cli);
