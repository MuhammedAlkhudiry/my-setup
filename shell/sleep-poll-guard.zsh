#!/bin/zsh -f

# Claude PreToolUse hook for Bash. Most commands never mention sleep, so they pass without starting Bun.
input="$(cat)"
[[ "$input" == *sleep* ]] || exit 0
print -rn -- "$input" | exec bun --no-env-file "${0:A:h:h}/src/commands/sleep-poll-guard-cli.ts"
