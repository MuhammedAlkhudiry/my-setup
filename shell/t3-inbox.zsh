#!/bin/zsh
# Forced SSH command for spare Macs' inbox keys: the only thing such a key can do is post the message on stdin
# to the Housekeeper thread on this Mac. A spare Mac runs: ssh main-mac-inbox send <<< "message".
# authorized_keys: restrict,command="<this file> <mac name>" ssh-ed25519 ...

set -euo pipefail

HOUSEKEEPER_THREAD="feb86885-0ba2-42b9-9bf2-2a149f93fd86"
from=${1:?mac name}

if [[ ${SSH_ORIGINAL_COMMAND:-} != send ]]; then
  print -u2 "t3-inbox: only 'send' is allowed, with the message on stdin"
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
