#!/bin/zsh
# Copies this setup checkout, this Mac's Herd PHP and MinIO, and its Typesense config to each spare Mac given as an
# argument and installs the setup there. Spare Macs hold a read-only copy, writable only during the sync (see
# mirror-spare-copy.zsh).
# Install starts this in the background; prints one line per Mac, plus one for any local edits the backstop saved.

set -uo pipefail

root=${0:A:h:h}
relative=${root#$HOME/}
spare=$root/shell/mirror-spare-copy.zsh
herd="$HOME/Library/Application Support/Herd"
herd_remote='Library/Application\ Support/Herd'

# Spare Macs run this Mac's Herd PHP, so their tests get the same PHP build, ICU, and settings. Herd's PHP binaries are
# static and run without Herd; php.ini lines that load files from Herd.app are dropped. Site certificates and the public
# CA certificate come too, because project dev-server configs read the paths their copied .env files name; the CA's
# private key stays here. Skips a Mac with its own Herd.
copy_herd() {
  local host=$1 staging binary version
  [[ -e $herd/bin/php ]] || return 0
  ssh -o BatchMode=yes "$host" test -d /Applications/Herd.app && return 0

  staging=$(mktemp -d)
  for binary in "$herd"/bin/php<->(N); do
    version=${binary:t:s/php/}
    mkdir -p "$staging/$version"
    grep -v '/Applications/Herd.app' "$herd/config/php/$version/php.ini" >"$staging/$version/php.ini"
  done
  cp "$herd/config/php/cacert.pem" "$staging/"

  ssh -o BatchMode=yes "$host" "mkdir -p $herd_remote/bin $herd_remote/config/php $herd_remote/config/valet" &&
    rsync -a --include='php' --include='php[0-9][0-9]' --include='composer' --exclude='*' \
      "$herd/bin/" "$host:$herd_remote/bin/" &&
    rsync -a --delete "$staging/" "$host:$herd_remote/config/php/" &&
    rsync -a --delete --include='Certificates/' --include='Certificates/*.crt' --include='Certificates/*.key' \
      --include='CA/' --include='CA/*.pem' --exclude='*' "$herd/config/valet/" "$host:$herd_remote/config/valet/"
  local copied=$?
  rm -rf "$staging"
  return $copied
}

# Projects' copied .env files hold this Mac's Typesense API key, so spare Macs run Typesense with this Mac's config and
# restart it when the config changed.
copy_typesense() {
  local host=$1 config=/opt/homebrew/etc/typesense/typesense.ini changed
  [[ -f $config ]] || return 0

  changed=$(rsync -a --itemize-changes "$config" "$host:$config") || return 1
  [[ -z $changed ]] && return 0
  ssh -o BatchMode=yes "$host" "zsh -lic 'brew services list | grep -o \"^typesense-server[^ ]*\" | xargs -n1 brew services restart'"
}

# Projects' copied .env files keep files in Herd's MinIO: S3 on 127.0.0.1:9000, public URLs on https://minio.herd.test.
# Spare Macs without Herd get this Mac's MinIO binary and data; mirror-spare-minio.zsh runs MinIO and the HTTPS site.
# Objects only a spare Mac uploaded stay there. Runs after the checkout copy, which holds the site's proxy.
copy_minio() {
  local host=$1 binary data changed
  binary=(/Users/Shared/Herd/services/minio/*/minio-arm64(N))
  data=("$herd"/config/services/*/.minio.sys(N/:h))
  (( $#binary && $#data )) || return 0
  ssh -o BatchMode=yes "$host" test -d /Applications/Herd.app && return 0

  ssh -o BatchMode=yes "$host" "mkdir -p $herd_remote/bin $herd_remote/services/minio" &&
    rsync -a "${binary[-1]}" "$host:$herd_remote/bin/minio" || return 1
  changed=$(rsync -a --itemize-changes --exclude .minio.sys/tmp --exclude .minio.sys/multipart \
    "${data[1]}/" "$host:$herd_remote/services/minio/") || return 1
  ssh -o BatchMode=yes "$host" zsh -s -- "$relative" "${${(M)changed:#*.minio.sys/*}:+restart}" \
    <"$root/shell/mirror-spare-minio.zsh"
}

for host in "$@"; do
  if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" true 2>/dev/null; then
    print "$host: offline, skipped"
    continue
  fi

  copy_herd "$host" >/dev/null 2>&1 || print "$host: could not copy Herd PHP"
  copy_typesense "$host" >/dev/null 2>&1 || print "$host: could not copy the Typesense config"

  if ! edits=$(ssh -o BatchMode=yes "$host" zsh -s -- unlock "$relative" <"$spare" 2>&1); then
    print "$host: could not save local edits or unlock the copy, skipped: ${edits//$'\n'/ }"
    continue
  fi
  [[ -n $edits ]] && print "$host: $edits"

  if rsync -a --delete --no-specials --no-devices --exclude node_modules --exclude .git "$root/" "$host:$relative/"; then
    summary=$(ssh -o BatchMode=yes "$host" \
      "cd ~/$relative && zsh -lic 'bun install --frozen-lockfile >/dev/null 2>&1; mise run install' 2>&1" |
      grep -oE 'my-setup install: ok|doctor: [^;]*' | tail -1)
    print "$host: ${summary:-install failed}"
    copy_minio "$host" >/dev/null 2>&1 || print "$host: could not set up Herd's MinIO"
  else
    print "$host: copy failed"
  fi

  ssh -o BatchMode=yes "$host" zsh -s -- lock "$relative" <"$spare" >/dev/null 2>&1 ||
    print "$host: could not make the copy read-only again"
done
