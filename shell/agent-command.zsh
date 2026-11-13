# Shared preflight for installed command launchers.
agent_command() {
  local name="$1" script="$2"
  shift 2

  # A spare Mac's mise shim can lack a global bun version, so fall back to Bun's own install.
  local bun_bin="bun"
  if ! bun --version >/dev/null 2>&1 && [[ -x "$HOME/.bun/bin/bun" ]]; then
    bun_bin="$HOME/.bun/bin/bun"
  fi

  if [[ ! -f "$script" ]] || ! "$bun_bin" --version >/dev/null 2>&1; then
    local log_dir="$(mktemp -d "${TMPDIR:-/tmp}/${name}-log.XXXXXX")"
    local log="$log_dir/full.log"
    { printf 'Script: %s\n' "$script"; printf 'Bun must be available in PATH. Run mise run install from %s.\n' "$MY_SETUP_ROOT"; } > "$log"
    chmod 600 "$log"
    printf '%s: launcher failed; log: %s\n' "$name" "$log" >&2
    return 1
  fi

  # Bun would otherwise load the caller's .env, and every child (tests, builds) would inherit that project's dev settings.
  exec "$bun_bin" --no-env-file "$script" "$@"
}
