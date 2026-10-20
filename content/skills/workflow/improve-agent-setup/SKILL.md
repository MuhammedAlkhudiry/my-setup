---
name: improve-agent-setup
description: Use to audit the agent setup and recommend improvements.
---

Recommend improvements without editing.

## Workflow

1. Review all areas below unless the user names one.
2. Inspect source, installed configuration, and recent tasks for repeated problems and wasted work/context. For context and task time, use
   `bun <skill-dir>/scripts/analyze-sessions.ts --help` for the current interface; `<skill-dir>` is the installed $improve-agent-setup directory.
3. For external tools, search GitHub Trending and current GitHub results for tools solving observed problems.
4. Rank by lasting value, evidence, effort, and risk. Give each idea's evidence, recurring benefit, and concrete direction. Mention rejected
   ideas only when the user is likely to consider them.

## Review areas

Never recommend GitHub branch protection or rulesets (up-to-date branches, removing admin bypass, merge queues, required checks).

- **Context:** token waste and confusing instructions/output.
- **Task speed:** model latency, large prompts, polling, subagents, failed requests.
- **Skills:** gaps, duplication, stale guidance, opportunities for scripts.
- **Rules:** scope, duplication, placement.
- **Install and tooling:** `doctor` results and source/installed drift.
- **Active projects:** stale records.
- **External tools:** benefits versus maintenance.
