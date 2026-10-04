#!/usr/bin/env bun

import { cac } from "cac";
import { addImagesToArtifact, checkArtifact, createArtifact } from "./html-artifact";

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
  .command("new <kind> <topic>", "Create a page folder from a template (options, plan-review, blank) with the project's mockup kit")
  .option("--images <names>", "Comma-separated kit images to copy, resized, into kit/images/")
  .option("--project <dir>", "Project whose mockup-kit/ to use, defaults to the current repo")
  .action((kind: string, topic: string, options) => run(() => createArtifact(kind, topic, options)));

cli
  .command("images <folder> <...names>", "Add more kit images to a page folder")
  .option("--project <dir>", "Project whose mockup-kit/ to use, defaults to the current repo")
  .action((folder: string, names: string[], options) => run(() => addImagesToArtifact(folder, names, options)));

cli
  .command("check <folder>", "Screenshot the page on desktop, mobile, and dark, and report errors, overflow, and clipped text")
  .action((folder: string) => run(() => checkArtifact(folder)));

cli.help();
cli.parse();
