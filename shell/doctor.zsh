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
MY_SETUP_ROOT="${MY_SETUP_ROOT:-${0:A:h:h}}"

print_header() {
  return 0
}

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
  print_header "Core repo tools"
  check_tool bun required "Runtime used internally by mise run install."
  check_tool git required "Needed for remote skill checkout, hooks, and shared git helpers."
  check_tool mise required "Needed for the supported local task workflow and global runtime management."
  check_tool node required "Hosts npm itself and the npm-installed agent CLIs."
  check_tool zsh required "Needed by all installed shared shell commands."

  print_header "Shell and helper integrations"
  check_tool rtk required "OpenCode shell output compression; install with brew install rtk."
  check_tool phpstorm optional "Used by the synced zsh config as the editor command."
  check_tool herd optional "Used by Laravel aliases in the synced zsh config."
  check_herd_php
  check_tool forge optional "Manages Laravel Forge servers and sites through the cli-tools skill."
  check_tool cf required "Cloudflare CLI: share-html uploads, deploys, and the whole Cloudflare API through the cli-tools skill."
  check_tool opencode optional "Used by the ai/opencode launcher and OpenCode workflows."
  check_tool codex optional "Used by Codex workflows and as a configured agent target."
  check_tool claude optional "Used by Claude Code workflows and as a configured agent target."
  check_tool cliproxyapi optional "Pools Claude OAuth accounts for the local T3 Code Claude provider."
  check_tool tailscale optional "Install the standalone app from tailscale.com so the phone and other Macs reach T3 Code."
  check_tool playwright-cli required "Fallback headless browser automation CLI."
  check_tool agent-device required "Default AI-agent mobile and device automation CLI."
  check_tool simslim required "Install with brew install mobai-app/tap/simslim; device-queue slims pool simulators with it."
  # Only Macs that run Android emulators need it; spare agent Macs have none.
  local avdslim_level=optional
  [[ -d "$HOME/Library/Android/sdk/emulator" ]] && avdslim_level=required
  check_tool avdslim "$avdslim_level" "Install from the kdbhalala/avdslim Homebrew tap; device-queue slims pool emulators with it."
  check_tool memcap required "Install with brew install alextitov19/memcap/memcap; mise run install manages its config and service."
  check_tool asc required "Install with brew install asc for App Store Connect releases and status."
  check_tool eas required "Install with bun add -g eas-cli for local store builds, EAS Submit, and updates."
  check_tool gpc required "Install with brew install yasserstudio/tap/gpc for Google Play releases and status."
  check_tool fzf optional "Used by the zsh fzf plugin and the project picker."
  check_tool sg optional "Install ast-grep for AST-shaped code search."
  check_tool magick optional "Used to inspect and measure raster UI references."
  check_tool ffmpeg optional "Used to edit demo recordings and render promo videos."
  check_tool mo optional "Install with brew install mole for macOS storage auditing and cleanup."
  check_tool wacli optional "Used to read and export WhatsApp data for authorized personal knowledge workflows."
  check_tool imsg optional "Used to read and export local SMS and iMessage data for authorized personal knowledge workflows."
  check_tool qmd required "Provides local keyword, semantic, and hybrid search for maintained personal knowledge."
  check_tool gcloud optional "Used for Google Cloud project, API, service account, and IAM workflows."

  print_header "Observability CLIs"
  check_tool posthog-cli required "Install the CLI for PostHog access without MCP."
  check_tool sentry required "Install the agent-oriented Sentry CLI for access without MCP."
  check_tool sentry-cli optional "Used by legacy Sentry SDK and CI build integrations."

  print_header "Credential storage"
  check_credentials_home

  print_header "Git workflow helpers"
  check_tool gh optional "Used for GitHub pull requests, CI runner switching and fresh PR evidence in worktree-cleanup."
  check_tool lsof required "Checks open files before worktree-cleanup removes finished work."
  check_tool du required "Measures worktree storage during cleanup; doctor reads cached sizes."
  check_tool find required "Checks file-change grace periods before worktree cleanup or storage pruning."
  check_tool mergiraf optional "Syntax-aware merge driver the merge queue uses when it merges main into a PR left behind."
  check_gh_extension signoff optional "Install with gh extension install basecamp/gh-signoff; sets up the branch rule that requires the local sign-off status."

  print_header "My Setup links"
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
  check_link heavy-run "$HOME/bin/heavy-run" "$MY_SETUP_ROOT/shell/heavy-run.zsh"
  check_link ci-runner "$HOME/bin/ci-runner" "$MY_SETUP_ROOT/shell/ci-runner.zsh"
  check_link wait-for "$HOME/bin/wait-for" "$MY_SETUP_ROOT/shell/wait-for.zsh"
  check_link claude-skills "$HOME/.claude_cliproxy/skills" "$HOME/.agents/skills"

  print_header "Managed skills"
  check_installed_skills

  print_header "Local hygiene"
  check_local_hygiene
  local telegram_output
  if telegram_output="$(bun "$MY_SETUP_ROOT/src/commands/telegram-send-cli.ts" webhook check 2>&1)"; then
    print_ok "Telegram ops bot" "$telegram_output"
    (( required_ok++ ))
  else
    print_missing required "Telegram ops bot" "$telegram_output"
    (( required_missing++ ))
  fi

  print_summary

  if (( required_missing > 0 || link_missing > 0 )); then
    return 1
  fi

  return 0
}

main "$@"
