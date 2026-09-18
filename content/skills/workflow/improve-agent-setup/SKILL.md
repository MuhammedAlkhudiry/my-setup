---
name: improve-agent-setup
description: Use to audit the agent setup — context, skills, rules, install, projects, external tools — and recommend improvements.
---

Recommend improvements without editing.

## Workflow

1. Review every area below for a broad audit, or only the area named by the user.
2. Inspect source files, installed configuration, and recent tasks for repeated problems, avoidable work, and wasted context. For context audits, run
   `scripts/analyze-codex-sessions.ts --help` and use its current interface. It covers Codex and Claude Code sessions; `--harness` limits the run to
   one of them.
3. For the external-tools review, search GitHub Trending and current GitHub results for agent tools that could solve the observed problems. Search
   other current external sources only when needed.
4. Rank ideas by lasting value, supporting evidence, effort, and risk.
5. Report the strongest recommendations first. For each, give the evidence, expected recurring benefit, and concrete implementation direction. Mention
   rejected ideas only when the user is likely to consider them.

## Review areas

- **Context:** unnecessary instructions and output that increase token use or make tasks harder to follow.
- **Skills:** gaps, duplication, outdated guidance, and work better handled by scripts.
- **Rules:** scope, duplication, and whether each rule lives in the right place.
- **Install and tooling:** setup health and differences between source and installed configuration.
- **Active projects:** current project records and environment health.
- **External tools:** current agent tools whose benefits justify the work of adding and maintaining them.
