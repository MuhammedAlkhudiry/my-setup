---
name: using-subagents
description: Delegating work to subagents or agent CLIs, selecting models, and verifying results.
---

| Task                     | Delegate to                            |
| ------------------------ | -------------------------------------- |
| Cheap, low-judgment work | Codex GPT Luna                         |
| Smart                    | Codex GPT Sol; Claude Opus as fallback |

- Never delegate to Sonnet, Fable, Astro.
- Prefer medium reasoning effort for delegated work. Set it explicitly when supported; use another level when the user requests it or the task
  warrants it.
- For Codex `spawn_agent`, explicitly set `fork_turns: "none"`; inherit context only when the user requests it
- $delegate-cli covers CLI mechanics.
