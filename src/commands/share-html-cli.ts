#!/usr/bin/env bun

import { agentOutput, parseCli } from "../lib/agent-output";
import { cac } from "cac";
import { readFeedback, shareHtml } from "./share-html";

agentOutput("share-html", {
  nativeJson: true,
  summary: (output) => output.trim().split("\n")[0] || "share-html: ok",
});

const cli = cac("share-html");

async function run(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

cli
  .command(
    "feedback [page]",
    "Print the feedback a writable page saved; defaults to the newest writable page",
  )
  .action((page?: string) => run(() => readFeedback(page)));

cli
  .command("<path>", "Publish an HTML file or a folder with index.html to a private URL")
  .option("--name <name>", "Readable part of the URL, defaults to the file or folder name")
  .option(
    "--writable",
    "Let the page save the user's feedback for 7 days, read back with `share-html feedback`",
  )
  .option(
    "--stable",
    "Keep one URL across publishes: replaces the page at the --name slug instead of adding a dated copy",
  )
  .option(
    "--dry-run",
    "List the files and the URL shape without uploading; each publish gets a new random suffix",
  )
  .action((path: string, options) => run(() => shareHtml(path, options)));

cli.option("--json", "Emit structured results");
cli.option("--verbose", "Print details");
cli.help();
parseCli(cli);
