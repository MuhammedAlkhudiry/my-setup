#!/bin/zsh -f

# Claude PreToolUse hook for Edit, Write and Bash: the setup checkout is read-only on spare Macs. On main-mac, the only Mac
# that edits it, every call passes without starting Bun. Bun may be only on the interactive PATH, so its usual homes are
# fallbacks; a hook that cannot start would let the write through.
[[ $(scutil --get LocalHostName 2>/dev/null) == main-mac ]] && exit 0
for bun in $commands[bun] $HOME/.bun/bin/bun /opt/homebrew/bin/bun; do
  [[ -x $bun ]] && exec "$bun" --no-env-file "${0:A:h:h}/src/commands/setup-readonly-guard-cli.ts"
done
print -u2 "setup-readonly-guard: bun not found. ${0:A:h:h} is read-only here anyway."
