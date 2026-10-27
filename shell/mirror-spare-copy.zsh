#!/bin/zsh
# Runs on a spare Mac, fed over SSH by mirror-setup.zsh so the main Mac's version always runs. The setup copy there is
# read-only: `lock` records it as mirrored and makes it non-writable, and `unlock` makes it writable for the next sync.
# Agents' installed dependencies and runtime state (node_modules, .claude) stay writable.
# Backstop: anything that still changed the copy, such as an agent without the setup hook running chmod, is saved by
# `unlock` as a patch and sent to the Housekeeper through the inbox before the mirror overwrites it.
# Usage: mirror-spare-copy.zsh unlock|lock <copy directory relative to home>

set -euo pipefail

action=${1:?unlock or lock}
copy=$HOME/${2:?copy directory relative to home}
state=${MIRROR_STATE_DIR:-$HOME/.local/state/my-setup}
repo=$state/mirror.git
inbox=(${=MIRROR_INBOX_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=5 main-mac-inbox send})

mirror_git() {
  git --git-dir="$repo" --work-tree="$copy" -c core.autocrlf=false "$@"
}

# Symlinks are skipped so a link never changes the permissions of what it points to.
set_writable() {
  find "$copy" \( -name node_modules -o -path "$copy/.claude" \) -prune -o ! -type l -exec chmod "$1" {} +
}

save_local_edits() {
  # Before the first recorded mirror there is nothing to compare with.
  mirror_git rev-parse -q --verify refs/mirrored >/dev/null 2>&1 || return 0
  mirror_git add -A
  local files=("${(@f)$(mirror_git diff --cached --name-only refs/mirrored)}")
  files=(${files:#})
  (( ${#files} )) || return 0

  mkdir -p "$state/mirror-edits"
  local patch=$state/mirror-edits/$(date -u +%Y%m%dT%H%M%SZ).patch
  mirror_git diff --cached --binary refs/mirrored >"$patch"
  local host=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
  local listed=${(j:, :)files[1,20]}
  (( ${#files} > 20 )) && listed+=", and $(( ${#files} - 20 )) more"

  local summary="${#files} local edits saved to $patch before the mirror overwrote them: $listed"
  if ! printf '%s\n' \
    "The my-setup mirror from main-mac overwrote local edits on $host in ~/${2}, which should be read-only there." \
    "Saved patch on $host: $patch" \
    "Files: $listed" \
    "To keep them, on main-mac: ssh $host cat $patch | git -C ~/${2} apply" | "${inbox[@]}" >/dev/null 2>&1; then
    summary+="; the Housekeeper inbox failed"
  fi
  print -r -- "$summary"
}

case $action in
  unlock)
    save_local_edits "$@"
    set_writable u+w
    ;;

  lock)
    if [[ ! -d $repo ]]; then
      git init -q --bare "$repo"
      # Agent runtime files in the copy, such as Claude's task lock, are not setup edits.
      print '/.claude/' >>"$repo/info/exclude"
    fi
    mirror_git add -A
    commit=$(mirror_git -c user.name=mirror -c user.email=mirror@localhost commit-tree "$(mirror_git write-tree)" -m mirrored)
    mirror_git update-ref refs/mirrored "$commit"
    set_writable a-w
    ;;

  *)
    print -u2 "usage: mirror-spare-copy.zsh unlock|lock <copy directory relative to home>"
    exit 64
    ;;
esac
