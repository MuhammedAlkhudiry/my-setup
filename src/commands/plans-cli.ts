#!/usr/bin/env bun

import { cac } from "cac";

import { runPlansCommand } from "./plans";

interface PlanOptions {
  project?: string;
  plansRoot?: string;
  all?: boolean;
  json?: boolean;
  description?: string;
  status?: string;
  write?: boolean;
}

const cli = cac("plans");

cli
  .command("<operation> [...query]", "Create, list, edit, status, or archive saved plans")
  .usage("<create|list|show|path|save|status|archive|archive-done|index> [query] [options]")
  .option("--project <project>", "Use a specific project plan folder")
  .option("--plans-root <path>", "Plans root", { default: "~/plans" })
  .option("--all", "Include every project plan folder when listing")
  .option("--json", "Print a machine-readable plan listing")
  .option("--description <description>", "Describe a plan being created")
  .option("--status <status>", "Set status to pending, progress, or done")
  .option("--write", "Rewrite INDEX.md when indexing")
  .example('plans create billing-brief --project awraq --description "Define billing" < brief.md')
  .example("plans list --all")
  .action((operation: string, query: string[], options: PlanOptions) => {
    const args = [...query];
    if (options.project) args.push(`--project=${options.project}`);
    if (options.plansRoot) args.push(`--plans-root=${options.plansRoot}`);
    if (options.all) args.push("--all");
    if (options.json) args.push("--json");
    if (options.description) args.push(`--description=${options.description}`);
    if (options.status) args.push(`--status=${options.status}`);
    if (options.write) args.push("--write");
    runPlansCommand(operation, args);
  });

cli.help();
cli.parse();
