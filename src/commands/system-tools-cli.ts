#!/usr/bin/env bun

import { agentOutput, parseCli } from "../lib/agent-output";
import { cac } from "cac";

import { collectSystemToolStatuses, systemToolStatusLabel } from "../lib/system-tools";

agentOutput("system-tools", {
  nativeJson: true,
  failures: (_output, errors) => errors.trim().split("\n").filter(Boolean),
});

const cli = cac("system-tools");

async function reportTools(plan: boolean): Promise<void> {
  const groups = await collectSystemToolStatuses();
  const statuses = groups.flatMap((group) => group.tools);
  const failed = statuses.filter(
    (status) =>
      status.probeError ||
      status.versionError ||
      (!status.path && status.tool.level === "required"),
  );

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        groups.map((group) => ({
          ...group,
          tools: group.tools.map((status) => ({
            ...status,
            status: systemToolStatusLabel(status),
          })),
        })),
      ),
    );
  } else {
    for (const status of statuses) {
      const current =
        status.current ??
        status.probeError ??
        status.versionError ??
        (status.path ? "installed" : "missing");
      console.log(
        `${status.tool.name}: ${systemToolStatusLabel(status)}; current=${current}; latest=${status.latest ?? status.latestError ?? "unknown"}${status.path ? `; path=${status.path}` : ""}`,
      );
      if (plan) {
        for (const command of status.tool.update.commands ?? []) console.log(command);
        if (status.tool.update.note) console.log(status.tool.update.note);
      }
    }
  }

  for (const status of failed) {
    console.error(
      `${status.tool.name}: ${status.probeError ?? status.versionError ?? "required tool missing"}`,
    );
  }
  if (failed.length) process.exitCode = 1;
}

cli.command("status", "Show installed external CLI tool versions").action(() => reportTools(false));

cli
  .command("update-plan", "Print safe update commands for external CLI tools")
  .action(() => reportTools(true));

cli.option("--json", "Emit structured results");
cli.option("--verbose", "Print details");
cli.help();
parseCli(cli);
