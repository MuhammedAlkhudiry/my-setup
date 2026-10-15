#!/usr/bin/env bun

import { agentOutput, parseCli } from "../lib/agent-output";
import { cac } from "cac";

import {
  personalKnowledgeCheck,
  personalKnowledgeFind,
  personalKnowledgeNew,
  personalKnowledgeReindex,
  personalKnowledgeSetup,
  personalKnowledgeStatus,
  type PersonalKnowledgeFindOptions,
  type PersonalKnowledgeNewOptions,
  type PersonalKnowledgeOptions,
} from "./personal-knowledge";

agentOutput("pk", {
  nativeJson:
    process.argv.includes("--format=json") ||
    (process.argv.includes("--format") &&
      process.argv[process.argv.indexOf("--format") + 1] === "json"),
  summary: (output) => (process.argv[2] === "new" ? output.trim().split("\n")[0] : "pk: ok"),
});

const cli = cac("pk");
const rootOption = "--root <path>";
const rootDescription =
  "Personal knowledge repository root (defaults to ~/PhpstormProjects/personal-knowledge)";

cli
  .command("setup", "Create the isolated qmd index and embed the maintained wiki")
  .option(rootOption, rootDescription)
  .action((options: PersonalKnowledgeOptions) => personalKnowledgeSetup(options));

cli
  .command("status", "Check repository structure and show qmd index health")
  .option(rootOption, rootDescription)
  .action((options: PersonalKnowledgeOptions) => personalKnowledgeStatus(options));

cli
  .command("check", "Validate wiki frontmatter, filenames, and wikilinks")
  .option(rootOption, rootDescription)
  .action((options: PersonalKnowledgeOptions) => personalKnowledgeCheck(options));

cli
  .command("new <type> <title>", "Create and index a wiki note from the repository template")
  .option("--no-index", "Create the note without adding it to wiki/index.md")
  .option(rootOption, rootDescription)
  .action((type: string, title: string, options: PersonalKnowledgeNewOptions) =>
    personalKnowledgeNew(type, title, options),
  );

cli
  .command("find <query>", "Search maintained personal knowledge through qmd")
  .option("--keyword", "Use fast BM25 keyword search")
  .option("--semantic", "Use vector similarity search")
  .option("-n, --limit <number>", "Maximum number of results")
  .option("--min-score <number>", "Minimum qmd relevance score")
  .option("--format <format>", "Output format: cli, json, csv, md, xml, or files")
  .option("--full", "Return full documents instead of snippets")
  .option(rootOption, rootDescription)
  .action((query: string, options: PersonalKnowledgeFindOptions) =>
    personalKnowledgeFind(query, options),
  );

cli
  .command("reindex", "Refresh the isolated qmd index and embeddings")
  .option(rootOption, rootDescription)
  .action((options: PersonalKnowledgeOptions) => personalKnowledgeReindex(options));

cli.option("--json", "Emit structured results");
cli.option("--verbose", "Print details");
cli.help();
parseCli(cli);
