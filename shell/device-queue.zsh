#!/usr/bin/env zsh

set -euo pipefail

MY_SETUP_ROOT="${MY_SETUP_ROOT:-${0:A:h:h}}"
source "$MY_SETUP_ROOT/shell/agent-command.zsh"
agent_command device-queue "$MY_SETUP_ROOT/src/commands/device-queue-cli.ts" "$@"
