---
name: remote-agent-host
description: Use when setting up a Mac as an always-on remote machine whose T3 Code environment is reached from other Macs and the phone over Tailscale.
---

The owner has already installed this setup and T3 Code on the Mac and signed in to the agents. Run each check, fix what you can, and give the owner
the exact command or click for anything that needs `sudo`, a system popup, or a sign-in. Wait for the owner to confirm before you continue.

## 1. Preconditions

- `doctor` passes the required tools.
- `sudo profiles show -type enrollment` shows no company enrollment. If it does, stop: the owner must ask the former owner to release the Mac
  from Apple Business Manager.
- `gh auth status` is signed in.

## 2. Tailscale

- Use the standalone app from tailscale.com, not Homebrew or the App Store. It updates itself and installs the `tailscale` CLI.
- The owner approves the network extension and signs in with the same account as the other devices.
- `tailscale status --json` shows `Self.Online` true and a non-empty `CertDomains`. If `CertDomains` is empty, the owner turns on MagicDNS and
  HTTPS Certificates on the Tailscale admin DNS page.

## 3. Identity

Give the Mac a short, distinct name, such as `agent-mac-1`. T3 shows the computer name and Tailscale uses the hostname, so set both:

```sh
sudo scutil --set ComputerName agent-mac-1
sudo scutil --set LocalHostName agent-mac-1
sudo scutil --set HostName agent-mac-1
tailscale set --hostname=agent-mac-1
```

## 4. Always reachable

A sleeping or restarting Mac drops every remote session.

```sh
sudo pmset -c sleep 0
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
```

The owner turns on Screen Sharing and Remote Login in System Settings → General → Sharing. They serve as a fallback when an agent is stuck on a GUI
prompt or T3 is down. The Mac stays plugged in with the lid open.

## 5. T3 over Tailscale

- Keep T3's Network access setting off. Tailscale Serve reaches the server on `127.0.0.1:3773`.
- Make pairing codes with the CLI version that matches the installed app, read from `CFBundleShortVersionString` in
  `/Applications/T3 Code*.app/Contents/Info.plist`:

  ```sh
  npx -y t3@<app-version> pair --tailscale --label "<client>" --ttl 30m
  ```

  This also maps `https://<host>.<tailnet>.ts.net` to T3. The mapping persists across restarts.

- Check `tailscale serve status` and that the HTTPS address returns 200.

## 6. Pair clients

Make one code per client. Each code works once.

| Client                  | Where to enter it                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| Main Mac T3 desktop app | Settings → Connections → add environment, paste the pairing URL                                |
| T3 iPhone app           | Settings → Environments → Add environment, host `https://<host>.<tailnet>.ts.net` and the code |

The phone camera opens a pairing QR code in Safari, not in the app. Give the phone the host and code.

## Done when

- The main Mac and the phone both list this environment and can open a thread on it.
- `tailscale ping <name>` from the main Mac gets a reply.
- The devices note in $personal-knowledge lists this Mac by its new name as a remote agent machine.
