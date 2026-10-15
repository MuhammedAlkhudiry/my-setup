#!/usr/bin/env bun

import { agentOutput, parseCli } from "../lib/agent-output";
import { cac } from "cac";

import { toolsStatus, toolsUpdatePlan } from "./tools";

agentOutput("system-tools", {
  nativeJson: true,
  failures: (_output, errors) => errors.trim().split("\n").filter(Boolean),
});

const cli = cac("system-tools");

cli.command("status", "Show installed external CLI tool versions").action(toolsStatus);

cli
  .command("update-plan", "Print safe update commands for external CLI tools")
  .action(toolsUpdatePlan);

cli.option("--json", "Emit structured results");
cli.option("--verbose", "Print details");
cli.help();
parseCli(cli);
