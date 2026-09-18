---
name: using-subagents
description: Use to decide whether to delegate work, which model and effort it gets, and how to check it; for CLI mechanics use $delegate-cli.
---

| Task                    | Delegate to                            |
| ----------------------- | -------------------------------------- |
| Routine work            | Codex GPT Luna                         |
| Work requiring judgment | Codex GPT Sol; Claude Opus as fallback |

- Never delegate to Sonnet, Fable, or Astro.
- Prefer medium reasoning effort for delegated work. Set it explicitly when supported; use another level when the user requests it or the task
  warrants it.
- For Codex `spawn_agent`, explicitly set `fork_turns: "none"`; inherit context only when the user requests it.
- $delegate-cli covers CLI mechanics.
