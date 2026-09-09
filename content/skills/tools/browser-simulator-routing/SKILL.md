---
name: browser-simulator-routing
description: Browser and simulator routing for web UI and reusable device flows.
---

# Routing

Honor an explicitly named browser, device tool, or automation surface. Otherwise, choose one surface using the rules below and keep using it unless
the task requirements change.

Before browser automation, use a purpose-built connector, API, or CLI when the operation is semantic and does not require browser UI interaction.

Prefer text snapshots such as the accessibility tree, DOM, or device snapshot over screenshots. When a screenshot is required, capture it at 1x scale
and crop it to the region under inspection before attaching it.

## Browser

- For browser UI interaction, including local web-app testing, prefer `$chrome:control-chrome`. Use `$playwriter` when the user requests it, it is
  already active for the task, or Chrome control remains unavailable after its setup recovery and the user did not explicitly choose a browser.
  Read and follow the selected skill before acting.
- If the user explicitly chose an unavailable browser surface, follow its setup recovery and then report the blocker. Do not silently substitute
  another browser.

## Simulator

- Use Maestro MCP when the user requests Maestro, an existing Maestro flow must be run or maintained, or the result must be reusable automation stored
  with the project. Use the MCP's live tools and documentation as the authority for supported actions and flow syntax.
- Use `$agent-device` for exploratory or one-off device interaction and for platforms outside the selected Maestro workflow. Read and follow the skill
  before acting.
- If the user explicitly chose an unavailable device surface, repair its setup when possible and then report the blocker. Do not silently substitute
  another surface.
