#!/bin/zsh -f

# Claude PreToolUse hook for Bash. Most commands never mention a device tool, so they pass without starting Bun.
input="$(cat)"
[[ "$input" == *(simctl|avdmanager|avdslim)* ]] || exit 0
print -rn -- "$input" | exec bun --no-env-file "${0:A:h:h}/src/commands/device-pool-guard-cli.ts"
