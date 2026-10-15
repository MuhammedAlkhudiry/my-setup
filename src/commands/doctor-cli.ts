#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { agentOutput } from "../lib/agent-output";

agentOutput("doctor", {
  nativeJson: true,
  failures: (output, errors) => {
    try {
      return JSON.parse(output)
        .checks.filter((item: { status: string }) => item.status === "required")
        .map((item: { name: string; detail: string }) => `${item.name}: ${item.detail}`);
    } catch {
      const findings = output.split("\n").filter((line) => line.trim().startsWith("[required]"));
      return findings.length
        ? findings.map((line) => line.trim().replace(/^\[required\]\s*/, ""))
        : errors.trim().split("\n").filter(Boolean).slice(-1);
    }
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
