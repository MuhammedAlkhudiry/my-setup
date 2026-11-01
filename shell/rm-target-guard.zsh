#!/bin/zsh -f

# Claude PreToolUse hook for Bash. Most commands neither run rm on a $-expanded target nor use zsh expansion flags, so they
# pass without starting Bun.
input="$(cat)"
[[ "$input" == *rm*'$'* || "$input" == *'${'[\(=~^]* ]] || exit 0
print -rn -- "$input" | exec bun --no-env-file "${0:A:h:h}/src/commands/rm-target-guard-cli.ts"
