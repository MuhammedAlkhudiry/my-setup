#!/usr/bin/env zsh

set -u

MY_SETUP_ROOT="${MY_SETUP_ROOT:-${0:A:h:h}}"
if [[ "${MY_SETUP_DOCTOR_DETAIL:-}" != "1" ]]; then
  source "$MY_SETUP_ROOT/shell/agent-command.zsh"
  agent_command "doctor" "$MY_SETUP_ROOT/src/commands/doctor-cli.ts" "$@"
  exit $?
fi

typeset -i required_ok=0
typeset -i required_missing=0
typeset -i optional_ok=0
typeset -i optional_missing=0
typeset -i link_ok=0
typeset -i link_missing=0

print_ok() {
  printf '[ok] %s %s\n' "$1" "$2"
}

print_missing() {
  printf '[%s] %s %s\n' "$1" "$2" "$3"
}

check_gh_extension() {
  local name="$1"
  local level="$2"
  local note="$3"

  if command -v gh >/dev/null 2>&1 && gh extension list 2>/dev/null | grep -q "^gh $name\b"; then
    print_ok "gh $name" "gh extension"
    if [[ "$level" == "required" ]]; then
      (( required_ok++ ))
    else
      (( optional_ok++ ))
    fi
    return 0
  fi

  print_missing "$level" "gh $name" "$note"
  if [[ "$level" == "required" ]]; then
    (( required_missing++ ))
  else
    (( optional_missing++ ))
  fi
}

print_summary() {
  printf 'doctor: required_missing=%d optional_missing=%d link_missing=%d\n' "$required_missing" "$optional_missing" "$link_missing"
}

check_tool() {
  local name="$1"
  local level="$2"
  local note="$3"
  local resolved_path

  resolved_path="$(command -v "$name" 2>/dev/null || true)"

  if [[ -n "$resolved_path" ]]; then
    print_ok "$name" "$resolved_path"
    if [[ "$level" == "required" ]]; then
      (( required_ok++ ))
    else
      (( optional_ok++ ))
    fi
    return 0
  fi

  print_missing "$level" "$name" "$note"
  if [[ "$level" == "required" ]]; then
    (( required_missing++ ))
  else
    (( optional_missing++ ))
  fi
}

# Every Mac runs Herd's PHP: spare Macs get the main Mac's copy through setup sync. Another PHP has another ICU, which
# changes currency and date formatting, so tests pass on one Mac and fail on another.
check_herd_php() {
  local resolved_path
  resolved_path="$(command -v php 2>/dev/null || true)"

  if [[ "$resolved_path" == "$HOME/Library/Application Support/Herd/bin/"* ]]; then
    print_ok php "$resolved_path"
    (( optional_ok++ ))
    return 0
  fi

  print_missing optional php "resolves to ${resolved_path:-nothing}, not Herd's PHP; on a spare Mac, rerun install on the main Mac."
  (( optional_missing++ ))
}

check_link() {
  local name="$1"
  local destination="$2"
  local expected_target="$3"
  local actual_target

  if [[ ! -L "$destination" ]]; then
    print_missing "required" "$name" "$destination is not a symlink"
    (( link_missing++ ))
    return 1
  fi

  actual_target="$(readlink "$destination" 2>/dev/null || true)"
  if [[ "$actual_target" != "$expected_target" ]]; then
    print_missing "required" "$name" "points to $actual_target"
    (( link_missing++ ))
    return 1
  fi

  if [[ ! -e "$expected_target" ]]; then
    print_missing "required" "$name" "target missing: $expected_target"
    (( link_missing++ ))
    return 1
  fi

  print_ok "$name" "$destination -> $expected_target"
  (( link_ok++ ))
}

check_installed_skills() {
  local output
  local script="$MY_SETUP_ROOT/src/commands/check-installed-skills.ts"

  if ! command -v bun >/dev/null 2>&1; then
    print_missing "required" "skills" "bun is required to check installed skill drift"
    (( required_missing++ ))
    return 1
  fi

  if [[ ! -f "$script" ]]; then
    print_missing "required" "skills" "$script is missing"
    (( required_missing++ ))
    return 1
  fi

  if output="$(bun "$script" 2>&1)"; then
    print_ok "skills" "$output"
    return 0
  fi

  print_missing "required" "skills" "installed skills drifted; run mise run install"
  printf '%s\n' "$output" | sed 's/^/    - /'
  (( required_missing++ ))
  return 1
}

check_local_hygiene() {
  local output check_status
  local script="$MY_SETUP_ROOT/src/commands/doctor-checks.ts"

  if [[ ! -f "$script" ]]; then
    print_missing "required" "hygiene" "$script is missing"
    (( required_missing++ ))
    return 1
  fi

  output="$(bun "$script" 2>&1)"
  check_status=$?
  if (( check_status == 0 )); then
    print_ok "hygiene" "$output"
    return 0
  fi

  while IFS=$'\t' read -r level detail; do
    [[ -z "$level" ]] && continue
    print_missing "$level" "hygiene" "$detail"
    if [[ "$level" == "required" ]]; then
      (( required_missing++ ))
    else
      (( optional_missing++ ))
    fi
  done <<< "$output"
  (( check_status == 1 )) && return 1
  return 0
}

check_file() {
  local name="$1"
  local path="$2"
  local note="$3"

  if [[ -f "$path" ]]; then
    print_ok "$name" "$path"
    (( required_ok++ ))
    return 0
  fi

  print_missing "required" "$name" "$note"
  (( required_missing++ ))
  return 1
}

check_credentials_home() {
  local credentials_home="${SERVICE_CREDENTIALS_HOME:-}"
  local invalid_path mode

  if [[ -z "$credentials_home" ]]; then
    print_missing "required" "credentials" "SERVICE_CREDENTIALS_HOME is not configured; run mise run install"
    (( required_missing++ ))
    return 1
  fi

  if [[ ! -d "$credentials_home" ]]; then
    print_missing "required" "credentials" "$credentials_home is missing; run mise run install"
    (( required_missing++ ))
    return 1
  fi

  mode="$(stat -f '%Lp' "$credentials_home" 2>/dev/null || true)"
  if [[ "$mode" != "700" ]]; then
    print_missing "required" "credentials" "$credentials_home must use mode 700 (found ${mode:-unknown})"
    (( required_missing++ ))
    return 1
  fi

  if ! invalid_path="$(find "$credentials_home" -mindepth 1 -type d ! -perm 700 -print -quit 2>/dev/null)"; then
    print_missing "required" "credentials" "Unable to verify directory permissions under $credentials_home"
    (( required_missing++ ))
    return 1
  fi
  if [[ -n "$invalid_path" ]]; then
    mode="$(stat -f '%Lp' "$invalid_path" 2>/dev/null || true)"
    print_missing "required" "credentials" "$invalid_path must use mode 700 (found ${mode:-unknown})"
    (( required_missing++ ))
    return 1
  fi

  if ! invalid_path="$(find "$credentials_home" -type f ! -perm 600 -print -quit 2>/dev/null)"; then
    print_missing "required" "credentials" "Unable to verify file permissions under $credentials_home"
    (( required_missing++ ))
    return 1
  fi
  if [[ -n "$invalid_path" ]]; then
    mode="$(stat -f '%Lp' "$invalid_path" 2>/dev/null || true)"
    print_missing "required" "credentials" "$invalid_path must use mode 600 (found ${mode:-unknown})"
    (( required_missing++ ))
    return 1
  fi

  print_ok "credentials" "$credentials_home (private paths verified)"
  (( required_ok++ ))
}

main() {
  # src/lib/system-tools.ts is the one tool inventory; its levels already allow for Macs without the Android SDK.
  local inventory name level why
  if inventory="$(bun "$MY_SETUP_ROOT/src/commands/system-tools-cli.ts" inventory 2>&1)"; then
    while IFS=$'\t' read -r name level why; do
      [[ -n "$name" ]] && check_tool "$name" "$level" "$why"
    done <<< "$inventory"
  else
    print_missing required system-tools "inventory unavailable: $inventory"
    (( required_missing++ ))
  fi

  check_herd_php

  check_credentials_home

  check_gh_extension signoff optional "Install with gh extension install basecamp/gh-signoff; sets up the branch rule that requires the local sign-off status."

  check_link zsh "$HOME/.config/zsh-sync/custom.zsh" "$MY_SETUP_ROOT/shell/zsh-custom.zsh"
  check_link my-setup "$HOME/bin/my-setup" "$MY_SETUP_ROOT/shell/my-setup.zsh"
  check_link system-tools "$HOME/bin/system-tools" "$MY_SETUP_ROOT/shell/system-tools.zsh"
  check_link worktree-cleanup "$HOME/bin/worktree-cleanup" "$MY_SETUP_ROOT/shell/worktree-cleanup.zsh"
  check_link hugeicons "$HOME/bin/hugeicons" "$MY_SETUP_ROOT/shell/hugeicons.zsh"
  check_link doctor "$HOME/bin/doctor" "$MY_SETUP_ROOT/shell/doctor.zsh"
  check_link pk "$HOME/bin/pk" "$MY_SETUP_ROOT/shell/pk.zsh"
  check_link share-html "$HOME/bin/share-html" "$MY_SETUP_ROOT/shell/share-html.zsh"
  check_link store-build "$HOME/bin/store-build" "$MY_SETUP_ROOT/shell/store-build.zsh"
  check_link merge-queue "$HOME/bin/merge-queue" "$MY_SETUP_ROOT/shell/merge-queue.zsh"
  check_link device-queue "$HOME/bin/device-queue" "$MY_SETUP_ROOT/shell/device-queue.zsh"
  check_link telegram-send "$HOME/bin/telegram-send" "$MY_SETUP_ROOT/shell/telegram-send.zsh"
  check_link verify "$HOME/bin/verify" "$MY_SETUP_ROOT/shell/verify.zsh"
  check_link decisions "$HOME/bin/decisions" "$MY_SETUP_ROOT/shell/decisions.zsh"
  check_link claude-skills "$HOME/.claude_cliproxy/skills" "$HOME/.agents/skills"

  check_installed_skills

  check_local_hygiene
  local telegram_output
  if telegram_output="$(bun "$MY_SETUP_ROOT/src/commands/telegram-send-cli.ts" webhook check 2>&1)"; then
    print_ok telegram-bot "$telegram_output"
    (( required_ok++ ))
  else
    print_missing required telegram-bot "$telegram_output"
    (( required_missing++ ))
  fi

  print_summary

  if (( required_missing > 0 || link_missing > 0 )); then
    return 1
  fi

  return 0
}

main "$@"
