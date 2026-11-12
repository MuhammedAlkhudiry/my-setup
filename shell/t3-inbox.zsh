#!/bin/zsh
# Forced SSH command for spare Macs' inbox keys: such a key can only post the message on stdin to a keeper thread on
# this Mac (ssh main-mac-inbox send [housekeeper|ops|business] <<< "message"; the Housekeeper by default), or reach this Mac's merge queue with `merge-queue add`,
# `merge-queue status`, or `merge-queue wait`, which spare Macs' merge-queue command does for them. The CLI validates forwarded arguments.
# authorized_keys: restrict,command="<this file> <mac name>" ssh-ed25519 ...

set -euo pipefail

from=${1:?mac name}
setup=${0:A:h:h}

if [[ ${SSH_ORIGINAL_COMMAND:-} == "merge-queue "* ]]; then
  # (z) splits words without expanding anything; quotes stay literal and fail the CLI's validation.
  words=(${(z)SSH_ORIGINAL_COMMAND})
  export MERGE_QUEUE_FORWARDED_FROM=$from
  exec /bin/zsh -lc 'source "$1" || exit; shift; exec "$@"' t3-inbox "$setup/shell/zsh-custom.zsh" \
    "$setup/shell/merge-queue.zsh" "${(@)words[2,-1]}" </dev/null
fi

case ${SSH_ORIGINAL_COMMAND:-} in
  send) keeper=housekeeper ;;
  "send housekeeper" | "send ops" | "send business") keeper=${SSH_ORIGINAL_COMMAND#send } ;;
  *)
    print -u2 "t3-inbox: only 'send [housekeeper|ops|business]' (message on stdin) and 'merge-queue add|status|wait' are allowed"
    exit 64
    ;;
esac
# Keeper thread ids; a keeper without one falls back to the Housekeeper, as keeper-core.md describes.
thread=$(/usr/bin/plutil -extract "$keeper" raw -o - "$setup/config/keeper-threads.json" 2>/dev/null ||
  /usr/bin/plutil -extract housekeeper raw -o - "$setup/config/keeper-threads.json")

message=$(head -c 20000)
if [[ -z ${message//[[:space:]]/} ]]; then
  print -u2 "t3-inbox: empty message"
  exit 65
fi

printf 'From an agent on %s (via the spare-Mac inbox):\n\n%s\n' "$from" "$message" |
  "$HOME/.t3/bin/t3" thread send "$thread" - >/dev/null
print "t3-inbox: sent to $keeper"
