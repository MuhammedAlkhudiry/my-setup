---
name: browser-simulator-routing
description: Use before any browser, simulator, or emulator automation to pick the right tool and capture mode for the task.
---

## Rules

- If you are not Codex, use these browser tools for QA only, such as checking pages or flows of the product you are building. Delegate other
  browser work to a Codex subagent; use the Codex CLI through $ai-agents-cli only when Codex delegation is unavailable.
- Use the tool the user names. If it is unavailable, repair its setup when possible, then report the blocker. Do not substitute another tool.
- Otherwise, use the first available tool in [Tools](#tools) that fits the task, and keep it unless the task changes.
- Use a connector, API, or CLI instead when the task does not need the UI.
- Prefer text snapshots. For a screenshot, capture at 1x and crop it to the region you inspect.
- Accept cookie banners and standard site terms that the task needs. Ask before accepting terms that cost money, sign a contract, or share personal
  data.
- Run `playwright-cli` headless in a named session. Clean up after yourself: close every session you opened when the task is done.
- Use the iOS simulator unless the work is Android-specific. Keep the device window visible; never run it headless.
- Lease a simulator or emulator before booting, building onto, or driving it, as [Device queue](#device-queue) says.
- Create a new iOS simulator on the newest installed iOS version. When the project pins its iOS builds to an older Xcode major, such as in an
  EAS build image, use the newest installed iOS of that major instead, because the app may not launch on newer iOS until the pin is removed.
- Obtain explicit user approval before starting or using an Android emulator, including one already running. Android-specific work alone
  does not authorize emulator use; an explicit request to use the emulator does. Approval remains valid for the authorized task.
- Before signing in on a new simulator or emulator, set up local HTTPS trust with $mobile-app-infra.
- Before starting long agent work on a simulator or emulator that is not slimmed, slim it with $mobile-app-infra.

## Device queue

```sh
device-queue acquire <udid-or-avd-name> --owner "<thread title>"
```

- Run `acquire` in the background when queued. Exit 75 means still queued; retry within two minutes to keep your place.
- Reuse your leased device instead of creating another.
- Use `--json` for receipts or `--verbose` for details. Acquire the device before `heavy-run --class build -- <argv...>`; never wait for a device while holding host capacity.
- Renew with `acquire` before each round. After 15 idle minutes without renewal or a device build, a waiting agent can take it.
  Release and shut down with `device-queue release <id>`.

## Tools

Rows are in order of preference within each area.

| Area    | Tool                                 | Use when                                                                                 |
| ------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Browser | T3 Code preview (`preview_*` tools)  | The host provides it.                                                                    |
| Browser | $chrome:control-chrome               | The runtime provides it.                                                                 |
| Browser | Claude Code Chrome (`--chrome`)      | A Claude Code session needs the user's signed-in Chrome state.                           |
| Browser | `playwright-cli`                     | No other browser tool fits.                                                              |
| Device  | T3 Code device panel (`device_open`) | The host provides it. Drive the opened device with the $agent-device command it returns. |
| Device  | $agent-device                        | Any other device work.                                                                   |
