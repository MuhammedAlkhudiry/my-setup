---
name: remote-agent-host
description: Use to set up an always-on Mac for remote T3 Code access over Tailscale.
---

Assume the setup, T3 Code, and agent sign-ins are installed. Fix failed checks; give the owner exact commands/clicks for `sudo`, system popups, or
sign-in, and wait for confirmation before dependent work.

## Preconditions

- `doctor` passes; `gh auth status` is signed in.
- `sudo profiles show -type enrollment` shows no company enrollment. Otherwise stop until the former owner releases the Mac from Apple Business Manager.

## Tailscale

- Use the standalone [Tailscale app](https://tailscale.com/download/mac), not Homebrew or the App Store.
- The owner approves the network extension and signs in with the other devices' account.
- Require `Self.Online: true` and non-empty `CertDomains` in `tailscale status --json`. For empty `CertDomains`, enable MagicDNS and HTTPS Certificates
  on the [admin DNS page](https://login.tailscale.com/admin/dns).

## Identity

Choose a short, distinct name. Set `ComputerName`, `LocalHostName`, and `HostName` with `sudo scutil --set`, and Tailscale's name with
`tailscale set --hostname`. T3 displays the computer name; Tailscale uses the hostname.

## Availability

```sh
sudo pmset -c sleep 0
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
```

Keep the Mac plugged in with its lid open. Enable Screen Sharing and Remote Login in System Settings → General → Sharing as fallbacks for GUI prompts
or T3 outages.

## T3 access

- Keep T3's Network access off; Tailscale Serve reaches `127.0.0.1:3773`.
- Match the CLI version to the app's `CFBundleShortVersionString` in
  `/Applications/T3 Code*.app/Contents/Info.plist`:

  ```sh
  t3 pair --tailscale --label "<client>" --ttl 30m
  ```

  The HTTPS mapping persists across restarts. Check `tailscale serve status` and HTTP 200 from `https://<host>.<tailnet>.ts.net`.

- Make one single-use code per client. On Mac: Settings → Connections → add environment, paste the pairing URL. On iPhone: Settings → Environments
  → Add environment, enter the HTTPS host and code. Camera-scanned QR codes open Safari, so give the phone the host and code.

## Done when

- Both clients list the environment and open a thread on it; `tailscale ping <name>` from the main Mac replies.
- The $personal-knowledge devices note records the Mac's new name and remote-agent role.
