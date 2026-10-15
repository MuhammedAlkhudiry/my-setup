#!/usr/bin/env bun

import { execa } from "execa";
import { agentOutput } from "../lib/agent-output";

agentOutput("check", {
  nativeJson: true,
  summary: (output) => output.trim().split("\n").at(-1) ?? "check: ok",
  failures: (_output, errors) => errors.split("\n").filter((line) => /: failed \(exit /.test(line)),
});

const formatFiles = [
  "src/cli.ts",
  "src/commands",
  "src/lib",
  "config",
  "**/*.md",
  "package.json",
  "tsconfig.json",
  ".oxfmtrc.json",
  ".oxlintrc.json",
];
const commands: Record<string, string[][]> = {
  format: [["bun", "node_modules/oxfmt/dist/cli.js", ...formatFiles]],
  "format:check": [["bun", "node_modules/oxfmt/dist/cli.js", "--check", ...formatFiles]],
  lint: [
    ["bun", "node_modules/oxlint/dist/cli.js", "."],
    ["bun", "src/commands/check-models.ts"],
  ],
  "lint:fix": [["bun", "node_modules/oxlint/dist/cli.js", "--fix", "."]],
  typecheck: [["bun", "check"]],
  test: [["bun", "test"]],
};
const [task = "check", ...args] = process.argv.slice(2);
const json = args.includes("--json");
const extra = args.filter((arg) => arg !== "--json" && arg !== "--");
if (task === "--help" || args.includes("--help")) {
  console.log(
    "Usage: check [check|format|format:check|lint|lint:fix|typecheck|test] [--json] [--verbose]",
  );
  process.exit(0);
}
const tasks = task === "check" ? ["format:check", "lint", "typecheck", "test"] : [task];
if (tasks.some((name) => !commands[name])) {
  console.error(`Unknown check: ${task}`);
  process.exit(2);
}

const results = await Promise.all(
  tasks.map(async (name) => {
    let output = "";
    for (const [command, ...argv] of commands[name]) {
      const result = await execa(command, [...argv, ...extra], {
        reject: false,
        cwd: new URL("../../", import.meta.url),
        all: true,
      });
      output += `${result.all ?? ""}\n`;
      if (result.failed) return { name, exitCode: result.exitCode ?? 1, output };
    }
    return { name, exitCode: 0, output };
  }),
);
const failed = results.filter((result) => result.exitCode !== 0);

if (json) console.log(JSON.stringify({ results, exitCode: failed.length ? 1 : 0 }));
else {
  for (const result of results) process.stdout.write(result.output);
  console.log(`${task}: ${failed.length ? `${failed.length} failed` : "ok"}`);
}
for (const result of failed) console.error(`${result.name}: failed (exit ${result.exitCode})`);
process.exitCode = failed.length ? 1 : 0;
