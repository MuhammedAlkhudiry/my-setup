---
name: delegate-cli
description: Delegating tasks or second opinions to the Claude Code or Codex CLI.
---

Pick the model and reasoning effort with $using-subagents. Run the target CLI's live help before invoking it. Give each call one clear task, only the
context it needs, and a request for a concise response.

## Claude Code

- Conserve the Claude Pro allowance. Use one fresh call through the `claude` CLI.

## Codex

- Run fresh, non-interactive `codex exec` calls; set the model the routing table selects.

## OpenCode

- Read the refreshed verbose model catalog, then use `opencode-go/glm-5.3-flash`.
- Use the `high` reasoning level, not the model's highest available level.
