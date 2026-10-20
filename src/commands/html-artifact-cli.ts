#!/usr/bin/env bun

import { agentOutput, parseCli } from "../lib/agent-output";
import { cac } from "cac";
import { checkArtifact, createArtifact } from "./html-artifact";

agentOutput("html-artifact", {
  nativeJson: true,
  summary: (output) => output.trim().split("\n")[0] || "html-artifact: ok",
  failures: (output, errors) => {
    try {
      return JSON.parse(output).problems ?? [];
    } catch {
      return [
        ...output
          .split("\n")
          .filter((line) => line.trim().startsWith("- "))
          .map((line) => line.trim().slice(2)),
        ...errors.trim().split("\n").filter(Boolean).slice(0, 1),
      ];
    }
  },
});

const cli = cac("html-artifact");

async function run(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

cli
  .command("new <topic>", "Create an empty page folder with feedback.js")
  .action((topic: string) => run(() => createArtifact(topic)));

cli
  .command(
    "check <folder>",
    "Screenshot the page on desktop, mobile, and dark, and report errors, overflow, and clipped text",
  )
  .action((folder: string) => run(() => checkArtifact(folder)));

cli.option("--json", "Emit structured results");
cli.option("--verbose", "Print details");
cli.help();
parseCli(cli);
