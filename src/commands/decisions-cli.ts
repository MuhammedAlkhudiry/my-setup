#!/usr/bin/env bun

import { readFileSync } from "node:fs";

import { cac } from "cac";

import {
  DecisionIndex,
  DecisionsError,
  EXIT,
  formatFull,
  formatResults,
  resolveCheckout,
} from "../lib/decisions";

interface SearchOptions {
  keywords?: string | number;
  project?: string;
  limit?: string | number;
  json?: boolean;
  full?: boolean;
  verbose?: boolean;
}

const help = `Exit codes: 0 decisions found, 1 none matched, 2 invalid input or no project, 3 index or search failed.
The index refreshes itself when decision files changed, so there is no reindex step.
Example: decisions search "should the AI ping the founder when a user says they feel depressed" --keywords "notify owner"`;

async function search(task: string, options: SearchOptions): Promise<void> {
  const cwd = process.cwd();
  const limit = Number(options.limit ?? 5);
  if (!Number.isInteger(limit) || limit < 1)
    throw new DecisionsError("--limit needs a positive whole number");

  const checkout = await resolveCheckout(cwd, options.project);
  const index = new DecisionIndex(checkout, undefined, undefined, options.verbose);
  const reindexed = await index.ensureFresh();
  const keywords = options.keywords === undefined ? undefined : String(options.keywords);
  const decisions = await index.search(task, { keywords, limit });

  if (options.json) {
    const results = decisions.map((decision) =>
      options.full ? { ...decision, content: readFileSync(decision.path, "utf8") } : decision,
    );
    console.log(
      JSON.stringify({ project: checkout.project, root: checkout.root, reindexed, results }),
    );
  } else if (decisions.length) {
    console.log(
      options.full
        ? formatFull(decisions, cwd, checkout.root)
        : formatResults(decisions, cwd, checkout.root),
    );
  } else {
    console.log(`decisions: no ${checkout.project} decisions matched`);
  }
  process.exitCode = decisions.length ? EXIT.found : EXIT.none;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `decisions: ${message}${error instanceof DecisionsError ? "" : "; run decisions --help"}`,
  );
  process.exitCode = error instanceof DecisionsError ? error.exitCode : EXIT.usage;
}

const cli = cac("decisions");

cli
  .command("search <task>", "Find recorded product decisions related to a task, by meaning")
  .option(
    "--keywords <terms>",
    "Exact terms that must all appear, such as identifiers or glossary terms",
  )
  .option(
    "--project <id>",
    "Search this active project instead of the cwd's checkout (harium|awraq)",
  )
  .option("-n, --limit <number>", "Maximum results (default 5)")
  .option("--full", "Print the matching decision files instead of one line each")
  .option("--json", "Emit structured results")
  .option("--verbose", "Print qmd commands and output to stderr")
  .action((task: string, options: SearchOptions) => search(task, options).catch(fail));

cli.help((sections) => [...sections, { body: help }]);

try {
  cli.parse(process.argv, { run: false });
  if (cli.options.help) process.exit(EXIT.found);
  if (!cli.matchedCommand) {
    cli.outputHelp();
    process.exit(EXIT.usage);
  }
  await cli.runMatchedCommand();
} catch (error) {
  fail(error);
}
