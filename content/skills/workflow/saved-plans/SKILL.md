---
name: saved-plans
description: Save and manage plans for code and non-code tasks.
---

When the user asks to save or manage a plan, use the existing writable plan store and preserve the supplied content. When `lanes` is available, run
`lanes plans --help` and follow its help. Otherwise use the connected repository's existing plan location. When no writable plan store exists, return
the complete plan and state that it was not saved.

## Saved Plan Status

- Use `pending` for work that has not started, `progress` for work currently underway, and `done` for completed work.
- New plans default to `pending` when status is absent.
- Archive completed plans through the active plan store; bulk archive selects plans whose status is `done`.
