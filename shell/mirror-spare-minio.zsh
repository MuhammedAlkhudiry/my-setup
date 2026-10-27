#!/bin/zsh
# Runs on a spare Mac, fed over SSH by mirror-setup.zsh after it copies the main Mac's MinIO binary and data. Runs MinIO
# with Herd's default credentials, which the projects' copied .env files use, and serves https://minio.herd.test through
# minio-proxy.ts, as Herd does on the main Mac. Only root may listen on port 443, so the proxy is a launch daemon.
# Arguments: the setup checkout's path under the home folder, and "restart" when MinIO's own settings changed.

set -uo pipefail

relative=$1 restart=${2:-}
herd="$HOME/Library/Application Support/Herd"
agents=$HOME/Library/LaunchAgents
domain=gui/$(id -u)

# Writes a launch agent and loads it when it changed or is not loaded.
agent() {
  local label=$1 plist=$2 file=$agents/$1.plist
  if [[ -f $file && "$(<$file)" == "$plist" ]] && launchctl print "$domain/$label" >/dev/null 2>&1; then
    return 1
  fi

  launchctl bootout "$domain/$label" 2>/dev/null
  print -r -- "$plist" >"$file"
  launchctl bootstrap "$domain" "$file"
}

# The same for a root launch daemon.
daemon() {
  local label=$1 plist=$2 file=/Library/LaunchDaemons/$1.plist
  if [[ -f $file && "$(<$file)" == "$plist" ]] && sudo -n launchctl print "system/$label" >/dev/null 2>&1; then
    return 0
  fi

  sudo -n launchctl bootout "system/$label" 2>/dev/null
  print -r -- "$plist" | sudo -n tee "$file" >/dev/null
  sudo -n launchctl bootstrap system "$file"
}

plist() {
  local label=$1 environment=$2 argument
  shift 2
  print -r -- '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>'
  print -r -- "<key>Label</key><string>$label</string>"
  print -r -- "<key>ProgramArguments</key><array>"
  for argument in "$@"; do print -r -- "<string>$argument</string>"; done
  print -r -- "</array>$environment"
  print -r -- "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"
  print -r -- "<key>StandardErrorPath</key><string>$HOME/Library/Logs/$label.log</string>"
  print -r -- '</dict></plist>'
}

mkdir -p "$agents"
grep -q '[[:space:]]minio\.herd\.test$' /etc/hosts ||
  print '127.0.0.1 minio.herd.test' | sudo -n tee -a /etc/hosts >/dev/null

credentials='<key>EnvironmentVariables</key><dict><key>MINIO_ROOT_USER</key><string>herd</string>'
credentials+='<key>MINIO_ROOT_PASSWORD</key><string>secretkey</string></dict>'
agent com.my-setup.minio "$(plist com.my-setup.minio "$credentials" \
  "$herd/bin/minio" server --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 "$herd/services/minio")" ||
  [[ $restart != restart ]] ||
  launchctl kickstart -k "$domain/com.my-setup.minio"

# Root cannot use mise's shims, so the daemon names the real Bun binary; a Bun update rewrites it.
bun=$HOME/.bun/bin/bun
[[ -x $bun ]] || bun=$HOME/.local/share/mise/installs/bun/latest/bin/bun
daemon com.my-setup.minio-proxy "$(plist com.my-setup.minio-proxy '' \
  "$bun" "$HOME/$relative/src/commands/minio-proxy.ts" "$herd/config/valet/Certificates")"
exit 0
