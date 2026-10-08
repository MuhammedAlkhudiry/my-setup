---
name: ai-agents-cli
description: Use to run a task or second opinion through the Claude Code or Codex CLI, opus, astra, sol, fable, luna.
---

Before a call, read that CLI's help.

| CLI         | Command      | Model     | Effort                              | Notes                                                                            |
| ----------- | ------------ | --------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| Codex       | `codex exec` | `-m`      | `-c model_reasoning_effort=<level>` | Use `-s read-only` for second opinions. `-o <file>` saves only the final answer. |
| Claude Code | `claude -p`  | `--model` | `--effort`                          | One call per task; the plan's usage is limited.                                  |

- Prefer medium reasoning effort for delegated work. Set it explicitly when supported; use another level when the user requests it or the task
  warrants it.
- Split a review across subagents only when the diff is too large for one context.
- For Codex `spawn_agent`, explicitly set `fork_turns: "none"`; inherit context only when the user requests it.
- Run `codex exec` with `< /dev/null` unless you pipe the prompt in; with stdin left open, it waits for input forever.
- Run a long `codex exec` as the background command itself, so its exit notifies you. Never wait for it by matching `codex exec` in the process
  list; that also matches other sessions' Codex runs.
- `codex exec` cannot show Codex's per-app computer-use approval. If it fails with "Computer Use was not approved to use <app>", ask the user to
  allow that app once in the Codex app, then rerun.
