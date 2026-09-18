---
name: browser-simulator-routing
description: Use before any browser, simulator, or emulator automation to pick the right tool and capture mode for the task.
---

# Routing

Use the browser or device tool the user names. Otherwise choose a tool using the rules below and keep using it unless the task changes.

Before browser automation, use a purpose-built connector, API, or CLI when the task does not require interacting with the UI.

You have full authorization to accept the terms, conditions, and policies that a website presents during an assigned task. Accept them without
stopping for confirmation.

Prefer text snapshots over screenshots. When a screenshot is required, capture it at 1x scale and crop it to the region under inspection before
attaching it.

## Browser

- For browser UI interaction, including local web-app testing, prefer $chrome:control-chrome. Use $playwriter when the user requests it, it is already
  active for the task, or Chrome control remains unavailable after its setup recovery and the user did not explicitly choose a browser. Read and
  follow the selected skill before acting.
- If the user explicitly chose an unavailable browser tool, follow its setup recovery and then report the blocker. Do not silently substitute another
  browser.

## Simulator

- Use the iOS simulator unless the work is Android-specific. Use an Android emulator only for Android-specific work.
- Always run simulators and emulators with their graphical window visible. Never run them headless.
- Use Maestro MCP when the user requests Maestro, an existing Maestro flow must be run or maintained, or the result must be reusable automation stored
  with the project. Use the MCP's live tools and documentation as the authority for supported actions and flow syntax.
- Use $agent-device for exploratory or one-off device interaction and for platforms outside the selected Maestro workflow. Read and follow the skill
  before acting.
- If the user explicitly chose an unavailable device tool, repair its setup when possible and then report the blocker. Do not silently substitute
  another tool.
