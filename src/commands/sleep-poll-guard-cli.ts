#!/usr/bin/env bun

// Claude PreToolUse hook for Bash: blocks sleep-and-check polling with the one-line alternative, ending the turn when
// the job notifies or one wait-for. shell/sleep-poll-guard.zsh runs it only for commands that mention sleep.

import { SLEEP_POLL_MESSAGE, sleepPoll } from "../lib/sleep-poll-guard";

const input = JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: unknown } };
const command = input.tool_input?.command;
const poll = typeof command === "string" ? sleepPoll(command) : undefined;

if (poll) {
  console.error(`Blocked a ${poll}. ${SLEEP_POLL_MESSAGE}`);
  process.exit(2);
}
