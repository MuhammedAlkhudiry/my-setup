#!/usr/bin/env zsh

set -euo pipefail

MY_SETUP_ROOT="${MY_SETUP_ROOT:-${0:A:h:h}}"
script="$MY_SETUP_ROOT/src/commands/store-build-cli.ts"

if [[ ! -f "$script" ]]; then
  echo "store-build script not found at $script"
  echo "Run mise run install from $MY_SETUP_ROOT"
  exit 1
fi

exec bun "$script" "$@"
