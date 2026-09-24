---
name: using-subagents
description: Use to decide whether to delegate work, which model and effort it gets, and how to check it; for CLI mechanics use $ai-agents-cli.
---

| Task                    | Delegate to                            |
| ----------------------- | -------------------------------------- |
| Routine work            | Codex GPT Luna                         |
| Work requiring judgment | Codex GPT Sol; Claude Opus as fallback |

- Never delegate to Sonnet, Fable, or Astro.
- Prefer medium reasoning effort for delegated work. Set it explicitly when supported; use another level when the user requests it or the task
  warrants it.
- Split a review across subagents only when the diff is too large for one context.
- For Codex `spawn_agent`, explicitly set `fork_turns: "none"`; inherit context only when the user requests it.
