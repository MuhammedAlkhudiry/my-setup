#!/usr/bin/env bun

import { cac } from "cac";
import { shareHtml } from "./share-html";

const cli = cac("share-html");

cli
  .command("<path>", "Publish an HTML file or a folder with index.html to a private URL")
  .option("--name <name>", "Readable part of the URL, defaults to the file or folder name")
  .option("--dry-run", "List the files and the URL shape without uploading; each publish gets a new random suffix")
  .action(async (path: string, options) => {
    try {
      await shareHtml(path, options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

cli.help();
cli.parse();
