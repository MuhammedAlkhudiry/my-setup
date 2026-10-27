#!/bin/zsh -f

# Claude PreToolUse hook for Bash. Commands that never mention telegram-me pass without starting Bun.
input="$(cat)"
[[ "$input" == *telegram-me* ]] || exit 0
print -rn -- "$input" | exec bun --no-env-file "${0:A:h:h}/src/commands/telegram-me-guard-cli.ts"
