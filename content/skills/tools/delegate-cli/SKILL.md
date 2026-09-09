---
name: delegate-cli
description: Delegating tasks or second opinions to the Claude Code or Codex CLI.
---

Pick the model and reasoning effort with $using-subagents. Run the target CLI's live help before invoking it. Give each delegated call one outcome,
only the essential context, and a request for a concise response.

## Claude Code

- Treat the Claude Pro allowance as scarce: make one fresh, use `claude` cli.

## Codex

- Run fresh, non-interactive `codex exec` calls; set the model the routing table selects.

## OpenCode

- Read the refreshed verbose model catalog, then use `opencode-go/glm-5.3-flash`.
- Use the `high` reasoning level, not the model's highest available level.
