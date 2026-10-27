#!/bin/zsh -f

# Claude PreToolUse hook for Bash. Most commands never run rm on a $-expanded target, so they pass without starting Bun.
input="$(cat)"
[[ "$input" == *rm*'$'* ]] || exit 0
print -rn -- "$input" | exec bun --no-env-file "${0:A:h:h}/src/commands/rm-target-guard-cli.ts"
