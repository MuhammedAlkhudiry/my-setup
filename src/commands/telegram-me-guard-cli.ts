#!/usr/bin/env bun

// Claude PreToolUse hook for Bash: blocks telegram-me sends the owner has not approved and Keychain reads of their session.
// shell/telegram-me-guard.zsh runs it only for commands that mention telegram-me.

import { readDraft } from "../lib/telegram-me";
import { blockedTelegramCommand } from "../lib/telegram-me-guard";

const input = JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: unknown } };
const command = input.tool_input?.command;
const reason =
  typeof command === "string" ? blockedTelegramCommand(command, (id) => readDraft(id)) : undefined;

if (reason) {
  console.error(`Blocked. ${reason}`);
  process.exit(2);
}
