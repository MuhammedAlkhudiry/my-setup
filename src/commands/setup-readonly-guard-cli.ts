#!/usr/bin/env bun

// Claude PreToolUse hook: blocks Edit, Write and shell writes into the setup checkout on spare Macs, where the mirror from
// main-mac overwrites them. shell/setup-readonly-guard.zsh runs it only off main-mac.

import { join } from "node:path";

import {
  blockedSetupWrite,
  SETUP_READONLY_MESSAGE,
  type ToolCall,
} from "../lib/setup-readonly-guard";

const call = JSON.parse(await Bun.stdin.text()) as ToolCall;
const path = blockedSetupWrite(call, join(import.meta.dir, "../.."));

if (path) {
  console.error(`Blocked a write to ${path}. ${SETUP_READONLY_MESSAGE}`);
  process.exit(2);
}
