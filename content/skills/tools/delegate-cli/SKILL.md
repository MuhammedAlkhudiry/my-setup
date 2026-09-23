---
name: delegate-cli
description: Use to run a task or second opinion through the Claude Code or Codex CLI; to choose whether and to whom, use $using-subagents.
---

Choose the model and effort with $using-subagents. Before a call, read that CLI's help. Give each call one task, only the context it needs, and a
request for a short answer. Start a fresh session for each call.

| CLI         | Command      | Model     | Effort                              | Notes                                                                            |
| ----------- | ------------ | --------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| Codex       | `codex exec` | `-m`      | `-c model_reasoning_effort=<level>` | Use `-s read-only` for second opinions. `-o <file>` saves only the final answer. |
| Claude Code | `claude -p`  | `--model` | `--effort`                          | One call per task; the plan's usage is limited.                                  |
