#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOutput } from "../lib/agent-output";

function findings(output: string): { status: string; name: string; detail: string }[] {
  try {
    return JSON.parse(output).checks.filter((item: { status: string }) => item.status !== "ok");
  } catch {
    return output.split("\n").flatMap((line) => {
      const match = /^\s*\[(required|optional)\]\s+(gh signoff|\S+)\s+(.*)$/.exec(line);
      return match ? [{ status: match[1], name: match[2], detail: match[3] }] : [];
    });
  }
}

function summary(items: { status: string }[]): string {
  const failures = items.filter((item) => item.status === "required").length;
  const warnings = items.filter((item) => item.status === "optional").length;

  return `doctor: ${failures} failed, ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function findingText(item: { status: string; name: string; detail: string }): string {
  return `${item.status === "optional" ? "warning" : "required"}: ${item.name}: ${item.detail}`;
}

agentOutput("doctor", {
  nativeJson: true,
  summary: (output) => {
    const items = findings(output);
    if (!items.length) return "doctor: ok";

    // Warnings stay nonfatal, but keep their full context available just like failures.
    const log = join(mkdtempSync(join(tmpdir(), "doctor-warnings-")), "full.log");
    writeFileSync(log, output, { mode: 0o600 });

    return [...items.map((item) => `${findingText(item)}; log: ${log}`), summary(items)].join("\n");
  },
  failures: (output, errors) => {
    const items = findings(output);

    return items.length
      ? [...items.map(findingText), summary(items)]
      : errors.trim().split("\n").filter(Boolean).slice(-1);
  },
});

const args = process.argv.slice(2);
if (args.some((arg) => !["--json", "--help", "-h"].includes(arg))) {
  console.error("Usage: doctor [--json] [--verbose]");
  process.exit(2);
}
if (args.includes("--help") || args.includes("-h")) {
  const help =
    "Usage: doctor [--json] [--verbose]\nChecks tools, managed links, credentials, skills, and local hygiene.";
  console.log(args.includes("--json") ? JSON.stringify({ help }) : help);
  process.exit(0);
}

const result = spawnSync("zsh", [join(import.meta.dir, "../../shell/doctor.zsh")], {
  env: { ...process.env, MY_SETUP_DOCTOR_DETAIL: "1" },
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const checks = result.stdout.split("\n").flatMap((line) => {
  const match = /^\s*\[(ok|required|optional)\]\s+(gh signoff|\S+)\s+(.*)$/.exec(line);
  return match ? [{ status: match[1], name: match[2], detail: match[3] }] : [];
});

if (args.includes("--json")) console.log(JSON.stringify({ checks, exitCode: result.status ?? 1 }));
else process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
