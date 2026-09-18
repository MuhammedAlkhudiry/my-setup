#!/usr/bin/env zsh

set -u

typeset -i required_ok=0
typeset -i required_missing=0
typeset -i optional_ok=0
typeset -i optional_missing=0
typeset -i link_ok=0
typeset -i link_missing=0
GUM_BIN="$(command -v gum 2>/dev/null || true)"
MY_SETUP_ROOT="${MY_SETUP_ROOT:-${0:A:h:h}}"

has_gum() {
  [[ -n "$GUM_BIN" ]]
}

print_header() {
  printf '\n'
  if has_gum; then
    "$GUM_BIN" style --bold --foreground 81 "$1"
  else
    printf '%s\n' "$1"
  fi
}

print_ok() {
  if has_gum; then
    printf '  %s %-14s %s\n' \
      "$("$GUM_BIN" style --foreground 42 "[ok]")" \
      "$("$GUM_BIN" style --foreground 252 "$1")" \
      "$("$GUM_BIN" style --foreground 244 "$2")"
  else
    printf '  [ok]   %-14s %s\n' "$1" "$2"
  fi
}

print_missing() {
  if has_gum; then
    local color="214"
    [[ "$1" == "required" ]] && color="196"
    printf '  %s %-14s %s\n' \
      "$("$GUM_BIN" style --foreground "$color" "[$1]")" \
      "$("$GUM_BIN" style --foreground 252 "$2")" \
      "$("$GUM_BIN" style --foreground 244 "$3")"
  else
    printf '  [%s] %-14s %s\n' "$1" "$2" "$3"
  fi
}

print_summary() {
  printf '\n'
  if has_gum; then
    "$GUM_BIN" style --bold --foreground 81 "Summary"
    printf '  %s ok=%d missing=%d\n' "$("$GUM_BIN" style --foreground 252 "required:")" "$required_ok" "$required_missing"
    printf '  %s ok=%d missing=%d\n' "$("$GUM_BIN" style --foreground 252 "optional:")" "$optional_ok" "$optional_missing"
    printf '  %s ok=%d missing=%d\n' "$("$GUM_BIN" style --foreground 252 "links:")" "$link_ok" "$link_missing"
    printf '  %s\n' "$("$GUM_BIN" style --foreground 244 "note: this checks command presence and managed local setup, not auth, credentials, or full runtime access.")"
  else
    printf 'Summary\n'
    printf '  required: ok=%d missing=%d\n' "$required_ok" "$required_missing"
    printf '  optional: ok=%d missing=%d\n' "$optional_ok" "$optional_missing"
    printf '  links: ok=%d missing=%d\n' "$link_ok" "$link_missing"
    printf '  note: this checks command presence and managed local setup, not auth, credentials, or full runtime access.\n'
  fi
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
  check_tool phpstorm optional "Used by the synced zsh config as the editor command."
  check_tool herd optional "Used by Laravel aliases in the synced zsh config."
  check_tool opencode optional "Used by the ai/opencode launcher and OpenCode workflows."
  check_tool codex optional "Used by Codex workflows and as a configured agent target."
  check_tool claude optional "Used by Claude Code workflows and as a configured agent target."
  check_tool playwright-cli required "Default browser automation CLI when existing user browser state is not required."
  check_tool playwriter required "Controls signed-in Chrome tabs through the Playwriter extension."
  check_tool agent-device required "Default AI-agent mobile and device automation CLI."
  check_tool maestro required "Mobile E2E testing and bundled MCP server for agents."
  check_tool simslim required "Install with brew install mobai-app/tap/simslim for persistent lane simulator slimming."
  check_tool fzf optional "Used by project pickers and interactive saved-plan archiving."
  check_tool sg optional "Install ast-grep for AST-shaped code search."
  check_tool magick optional "Used to inspect and measure raster UI references."
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
  check_tool gh optional "Used to open GitHub pull requests from the command line."
  check_tool glab optional "Used to open GitLab merge requests from the command line."

  print_header "My Setup links"
  check_link zsh "$HOME/.config/zsh-sync/custom.zsh" "$MY_SETUP_ROOT/shell/zsh-custom.zsh"
  check_link my-setup "$HOME/bin/my-setup" "$MY_SETUP_ROOT/shell/my-setup.zsh"
  check_link system-tools "$HOME/bin/system-tools" "$MY_SETUP_ROOT/shell/system-tools.zsh"
  check_link hugeicons "$HOME/bin/hugeicons" "$MY_SETUP_ROOT/shell/hugeicons.zsh"
  check_link doctor "$HOME/bin/doctor" "$MY_SETUP_ROOT/shell/doctor.zsh"
  check_link knowledge "$HOME/bin/knowledge" "$MY_SETUP_ROOT/shell/knowledge.zsh"
  check_link pk "$HOME/bin/pk" "$MY_SETUP_ROOT/shell/pk.zsh"
  check_link ads "$HOME/bin/ads" "$MY_SETUP_ROOT/shell/ads.zsh"
  check_link plans "$HOME/bin/plans" "$MY_SETUP_ROOT/shell/plans.zsh"
  check_link claude-skills "$HOME/.claude/skills" "$HOME/.agents/skills"

  print_header "Managed skills"
  check_installed_skills

  print_header "Local hygiene"
  check_local_hygiene

  print_summary

  if (( required_missing > 0 || link_missing > 0 )); then
    return 1
  fi

  return 0
}

main "$@"
