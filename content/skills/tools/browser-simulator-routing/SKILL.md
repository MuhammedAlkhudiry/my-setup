---
name: browser-simulator-routing
description: Use before browser, simulator, or emulator automation.
---

- Non-Codex agents use browser tools for QA only. Delegate other browser work to Codex; use $ai-agents-cli only when delegation is unavailable.
- Use the named tool; repair missing setup and report blockers instead of substituting. Otherwise follow [Tools](#tools) until the task changes.
- Prefer a connector, API, or CLI when no UI is needed; text snapshots otherwise. Capture screenshots at 1x and crop to the inspected region.
- Accept needed cookie banners and standard terms. Ask before terms that cost money, sign a contract, or share personal data.
- Run `playwright-cli` headless in a named session; close sessions you opened when done.
- Prefer iOS unless the work is Android-specific. Keep device windows visible.
- [Lease devices](#device-queue) before booting, building onto, or driving them. Reuse an already booted leased device, and wait until it
  reports ready before opening or driving apps.
- Create iOS simulators on the newest installed iOS, limited to the pinned Xcode major when builds use one; newer iOS may not launch the app.
- Android emulator use requires explicit user approval, even for running emulators or Android-specific work. An explicit emulator request suffices
  for that task.
- Use $mobile-app-infra for local HTTPS trust before signing in on a new device, and for slimming before long work on an unslimmed device.

## Device queue

```sh
device-queue acquire <udid-or-avd-name> --owner "<thread title>"
```

- Run `acquire` in the background when queued. On exit 75, retry within two minutes to keep your place.
- Acquire before `heavy-run --class build -- <argv...>`; never hold host capacity while waiting for a device.
- Reuse the lease and renew with `acquire` before each round. After 15 idle minutes without renewal or a build, a waiting agent can take it.
- `device-queue release <id>` releases and shuts down the device.

## Tools

Use the first available tool that fits:

- **Browser:** T3 Code preview (`preview_*`) → $chrome:control-chrome → Claude Code `--chrome` for signed-in Chrome state → `playwright-cli`.
- **Device:** T3 Code `device_open` and the $agent-device command it returns; otherwise $agent-device.
