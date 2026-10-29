# Remote agent host details

## Owner first steps

- Install Tailscale from tailscale.com, not Homebrew or the App Store, and approve its network extension.
- Key-only SSH, in the setup command:

  ```sh
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/000-key-only.conf
  ```

- Put passwordless `sudo` in `/etc/sudoers.d/<user>-nopasswd` and check it with `visudo -cf`.
- Serving the command: `python3 -m http.server <port> --bind <main Mac's Tailscale IP>` on the main Mac, then the owner runs
  `curl -s <main-mac>:<port> | sh`. Stop the server and delete its folder afterwards.

## Identity

Set `ComputerName`, `LocalHostName`, and `HostName` with `sudo scutil --set`. T3 reads the computer name only at startup. Tailscale Serve
keeps the old name until `tailscale serve reset` and the mapping is added again.

## Never offline

- `sudo pmset -a sleep 0 disksleep 0 standby 0 powernap 0 autopoweroff 0 disablesleep 1`, and keep it plugged in.
- Turn off automatic macOS downloads and installs: a background update took a Mac off the network. The owner updates by hand.
- Require `Self.Online: true` and non-empty `CertDomains` in `tailscale status --json`. If `CertDomains` is empty, enable MagicDNS and
  HTTPS Certificates on the [admin DNS page](https://login.tailscale.com/admin/dns).
- Install keeps Spotlight indexing off (`sudo -n mdutil -a -i off`) and doctor flags it when it comes back: indexing a project's
  `node_modules` held a spare Mac's load above 30 and starved its Android emulator.
- FileVault off and automatic login both ask for the owner's password. macOS updates can turn FileVault back on, so check
  `fdesetup status` after each one.

## Tools and projects

- Install from the main Mac's Brewfile. Skip untrusted taps, and skip tooling for jobs the Mac won't do, such as Android emulators.
- PHP comes from the main Mac's Herd: setup sync copies its static PHP binaries, Composer, `php.ini` files, and site certificates
  into the same Herd folder, which the synced shell puts first on `PATH`. Homebrew's PHP has a newer ICU, which changes currency
  and date formatting, so tests that pass on the main Mac fail there.
- Setup sync also copies the main Mac's Herd MinIO binary and data, runs MinIO with Herd's default credentials, and serves
  `https://minio.herd.test` with the copied certificate, so the copied `.env` files' storage URLs work.
- Run Homebrew's MySQL, Redis, and Typesense as services. Setup sync copies the main Mac's `typesense.ini`, whose API key the
  projects' copied `.env` files use. Then run `mise run prepare` in each project.
- Xcode needs an App Store sign-in. Copy it from a Mac that has it instead:
  `ssh <from> 'tar -cf - -C /Applications Xcode.app' | ssh <to> 'sudo tar -xpf - -C /Applications'`. Then run `xcode-select -s`,
  `xcodebuild -license accept`, `xcodebuild -runFirstLaunch`, and `xcodebuild -downloadPlatform iOS`. A copied Xcode that was never
  opened leaves DeviceHub, Xcode 27's simulator app, unknown to Launch Services, so Expo cannot open simulators; install registers it.
- Apps whose entitlements include Sign in with Apple or associated domains need `ios.appleTeamId` in their Expo config. Without it,
  Expo wants an Apple Development certificate even for simulator builds, and only the main Mac has one.

## Accounts

- **Pool, once on the main Mac:** `tailscale serve --bg --tcp 18317 tcp://127.0.0.1:8317`. Sign ChatGPT accounts in with
  `cliproxyapi -config ~/.cli-proxy-api/config.yaml -codex-device-login`.
- **On the spare Mac:** copy the main Mac's `~/.cli-proxy-api/client-key` (mode 600). Add
  `"claudePoolUrl": "http://<main-mac>.<tailnet>.ts.net:18317"` to `~/.config/my-setup/device.json`, then rerun `mise run install`.
  Install points Claude Code and Codex at the pool. Codex there has no built-in image tool, so it makes images through the image skill's
  script and the pool's Images API.
- **Sign-ins over SSH:** a device-code sign-in started over SSH must keep running until it's approved, so start it with `nohup` and keep
  its log. Approve the code in the main Mac's signed-in browser; an agent can do this. Codes expire within minutes.

## T3

- Keep T3's Network access off; Tailscale Serve publishes `127.0.0.1:3773` over HTTPS. Check `tailscale serve status` and HTTP 200 from
  `https://<host>.<tailnet>.ts.net`.
- Mint pairing links over SSH. Non-interactive SSH has no `tailscale` on `PATH`:
  `ssh <host> 'PATH=/usr/local/bin:$PATH ~/.t3/bin/t3 pair --tailscale --label "<client>" --ttl 30m'`. Use one single-use link per client.
- Pairing on a Mac: Settings → Connections → add environment, then paste the link. On the iPhone: Settings → Environments → Add
  environment, then enter the HTTPS host and code. QR codes scanned with the camera open Safari instead.

## Talking between Macs

- **Main Mac to spare:** `t3 thread start <project path> - < brief` (with `--provider` and `--model`), `t3 thread send <id> -`, and
  `t3 thread show <id>`, all over SSH.
- **Spare to main:** give each spare Mac its own `~/.ssh/main-mac-inbox` key and a `main-mac-inbox` host entry. On the main Mac, authorize
  it as `restrict,command="<setup>/shell/t3-inbox.zsh <name>" <key>`; it can then only post to the Housekeeper, with
  `ssh main-mac-inbox send` and the message on stdin. The main Mac needs Remote Login and key-only SSH.
- **Merge queue:** only the main Mac runs a queue worker; install removes it from spare Macs. There, `merge-queue add` and
  `merge-queue status` go to the main Mac's queue through the same inbox key, and each entry records the spare Mac as `host`.
- T3's own MCP endpoint (`https://<host>.<tailnet>.ts.net/mcp`, with OAuth sign-ins renewed every 30 days) and its upstream
  linked-environment work may replace the inbox once they need no monthly approvals.

## Keeping the setup in sync

Add the spare Mac's SSH host to `"mirrors"` in the main Mac's `device.json`. Every install on the main Mac then copies its checkout,
including uncommitted changes, its Herd PHP, and its Typesense config to each mirror and installs it there in the background (log:
`~/Library/Logs/my-setup-mirror.log`).
Mirrors are read-only: the copy is non-writable except during the sync, and a Claude hook blocks writes to it off the main Mac with
the inbox command to send the change instead. As a backstop for anything that still changed it, the mirror saves those edits as a
patch in the spare Mac's `~/.local/state/my-setup/mirror-edits/`, sends them to the Housekeeper through the inbox, and notes them
in the mirror log before overwriting.

## Remote shells

Run tools through `zsh -lic` so `mise` and `bun` are on `PATH`. Use `rsync --no-specials --no-devices` for trees that hold sockets.
In zsh, write remote targets as `${host}:path`: in `$host:Path`, `:P` is a path modifier, so rsync copies into a local folder.
