#!/usr/bin/env bun

// Claude PreToolUse hook for Bash: blocks rm on a target built from a variable or command output, which would otherwise
// wait for a person to approve it. shell/rm-target-guard.zsh runs it only for commands that may contain one.

import { RM_GUARD_MESSAGE, unresolvedRemoval } from "../lib/rm-target-guard";

const input = JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: unknown } };
const command = input.tool_input?.command;
const removal = typeof command === "string" ? unresolvedRemoval(command) : undefined;

if (removal) {
  console.error(`Blocked \`${removal}\`. ${RM_GUARD_MESSAGE}`);
  process.exit(2);
}
