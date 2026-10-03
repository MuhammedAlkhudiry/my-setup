---
name: browser-simulator-routing
description: Use before any browser, simulator, or emulator automation to pick the right tool and capture mode for the task.
---

## Rules

- Use the tool the user names. If it is unavailable, repair its setup when possible, then report the blocker. Do not substitute another tool.
- Otherwise, use the first available tool in [Tools](#tools) that fits the task, and keep it unless the task changes.
- Use a connector, API, or CLI instead when the task does not need the UI.
- Prefer text snapshots. For a screenshot, capture at 1x and crop it to the region you inspect.
- Accept cookie banners and standard site terms that the task needs. Ask before accepting terms that cost money, sign a contract, or share personal
  data.
- Run `playwright-cli` headless in a named session. Clean up after yourself: close every session you opened when the task is done.
- Use the iOS simulator unless the work is Android-specific. Keep the device window visible; never run it headless.
- Before signing in on a new simulator or emulator, set up local HTTPS trust with $mobile-app-infra.
- Before starting long agent work on a simulator or emulator that is not slimmed, slim it with $mobile-app-infra.

## Tools

Rows are in order of preference within each area.

| Area    | Tool                                 | Use when                                                                                 |
| ------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Browser | T3 Code preview (`preview_*` tools)  | The host provides it.                                                                    |
| Browser | $chrome:control-chrome               | The runtime provides it.                                                                 |
| Browser | Claude Code Chrome (`--chrome`)      | A Claude Code session needs the user's signed-in Chrome state.                           |
| Browser | `playwright-cli`                     | No other browser tool fits.                                                              |
| Device  | Maestro MCP                          | The task runs, changes, or creates a Maestro flow stored in the project.                 |
| Device  | T3 Code device panel (`device_open`) | The host provides it. Drive the opened device with the $agent-device command it returns. |
| Device  | $agent-device                        | Any other device work.                                                                   |
