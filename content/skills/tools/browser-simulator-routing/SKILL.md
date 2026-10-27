---
name: browser-simulator-routing
description: Use before browser, simulator, or emulator automation.
---

- Non-Codex agents use browser tools for QA only. Delegate other browser work to Codex; use $ai-agents-cli only when delegation is unavailable.
- Use the named tool; repair missing setup and report blockers instead of substituting. Otherwise follow [Tools](#tools) until the task changes.
- To QA a project's own app, use its QA runbook commands first, such as `mise run qa:ios` or `mise run qa:web`: they run the checkout's
  servers with a seeded sign-in, lease the simulator or open a named `playwright-cli` session, and `mise run qa:stop` cleans up.
- Prefer a connector, API, or CLI when no UI is needed; text snapshots otherwise. Capture affected screens at 1x on one phone size
  by default, cropped to the inspected region. Add compact or enlarged-text shots only for layout or text-size
  changes; do not repeat before/after sets for unchanged screens.
- Accept needed cookie banners and standard terms. Ask before terms that cost money, sign a contract, or share personal data.
- Run `playwright-cli` headless in a named session; close sessions you opened when done.
- Prefer iOS unless the work is Android-specific. Keep device windows visible.
- [Lease devices](#device-queue) before booting, building onto, or driving them; never create, clone, boot, or slim one yourself.
- Android emulator use requires explicit user approval, except for bugs that exist only on Android. An explicit emulator request suffices
  for that task.
- Use $mobile-app-infra for local HTTPS trust before signing in on a new device.

## Device queue

```sh
device-queue acquire <project> <ios|android> [--kind <kind>] --owner "<thread title>"
```

- Each project has a fixed pool of devices by kind, such as `main`, `small`, or `rtl`. Without `--kind` you get a free device that keeps the
  app's own language, warm ones first; an unknown kind lists the project's kinds.
- The grant is a JSON receipt with the device `id` (simulator UDID or AVD name), `serial` for an emulator, and `ready: true`: the queue has
  booted and slimmed the device. Use the `id` for builds, `run`, and `release`.
- Run `acquire` in the background when queued. On exit 75, retry within two minutes to keep your place.
- Acquire before `heavy-run --class build -- <argv...>`; never hold host capacity while waiting for a device.
- Reuse the lease and renew with the same `acquire` command before each round; it returns the device you hold. After 15 idle minutes without renewal or a build, a waiting agent can take it.
- Run device-driving commands through `device-queue run <id> --owner "<thread title>" --timeout-seconds 120 -- <argv...>`;
  timeout kills the command group. Add `--json` before `--` when you need the command output. Keep builds under `heavy-run`.
- `device-queue release <id>` keeps the device warm for up to 30 minutes: one device, or two while the host has headroom. A waiting lease
  that needs the slot evicts it.
- This Mac runs up to five iOS simulators and two Android emulators at once. Two simulators always run; each slot above two opens only while
  CPU idle (smoothed over three minutes) is at least 30% and memory at least 45% free. Each AVD has 2 GiB RAM. Set `DEVICE_QUEUE_IOS_SLOTS`
  or `DEVICE_QUEUE_ANDROID_SLOTS` for another host.

## Tools

Use the first available tool that fits:

- **Browser:** T3 Code preview (`preview_*`) → $chrome:control-chrome → Claude Code `--chrome` for signed-in Chrome state → `playwright-cli`.
- **Device:** T3 Code `device_open` and the $agent-device command it returns; otherwise $agent-device.

agent-device snapshot nodes may omit refs; use an available ref or a supported selector. Replay no longer waits for target readiness,
and `readinessTimeoutMs` is rejected. Use an explicit `wait <selector>` before acting on a late target; `--settle` observes the result
after an action.
