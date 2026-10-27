#!/usr/bin/env bun

// Claude PreToolUse hook for Bash: blocks creating or cloning a simulator or emulator outside the device pool.
// shell/device-pool-guard.zsh runs it only for commands that mention a device tool.

import { blockedInvocation, GUARD_MESSAGE } from "../lib/device-pool-guard";

const input = JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: unknown } };
const command = input.tool_input?.command;

if (typeof command === "string" && blockedInvocation(command)) {
  console.error(GUARD_MESSAGE);
  process.exit(2);
}
