#!/bin/zsh
# Forced SSH command for spare Macs' inbox keys: such a key can only post the message on stdin to the Housekeeper
# thread on this Mac (ssh main-mac-inbox send <<< "message"), or reach this Mac's merge queue with `merge-queue add`
# or `merge-queue status`, which spare Macs' merge-queue command does for them. The CLI validates forwarded arguments.
# authorized_keys: restrict,command="<this file> <mac name>" ssh-ed25519 ...

set -euo pipefail

HOUSEKEEPER_THREAD="feb86885-0ba2-42b9-9bf2-2a149f93fd86"
from=${1:?mac name}
setup=${0:A:h:h}

if [[ ${SSH_ORIGINAL_COMMAND:-} == "merge-queue "* ]]; then
  # (z) splits words without expanding anything; quotes stay literal and fail the CLI's validation.
  words=(${(z)SSH_ORIGINAL_COMMAND})
  export MERGE_QUEUE_FORWARDED_FROM=$from
  exec /bin/zsh -lc 'source "$1" || exit; shift; exec "$@"' t3-inbox "$setup/shell/zsh-custom.zsh" \
    "$setup/shell/merge-queue.zsh" "${(@)words[2,-1]}" </dev/null
fi

if [[ ${SSH_ORIGINAL_COMMAND:-} != send ]]; then
  print -u2 "t3-inbox: only 'send' (message on stdin) and 'merge-queue add|status' are allowed"
  exit 64
fi

message=$(head -c 20000)
if [[ -z ${message//[[:space:]]/} ]]; then
  print -u2 "t3-inbox: empty message"
  exit 65
fi

printf 'From an agent on %s (via the spare-Mac inbox):\n\n%s\n' "$from" "$message" |
  "$HOME/.t3/bin/t3" thread send "$HOUSEKEEPER_THREAD" - >/dev/null
print "t3-inbox: sent to the Housekeeper"
