---
name: improve-agent-setup
description: Use to audit the agent setup — context, skills, rules, install, projects, external tools — and recommend improvements.
---

Recommend improvements without editing.

## Workflow

1. Review every area below for a broad audit, or only the area the user names.
2. Inspect source files, installed configuration, and recent tasks for repeated problems, avoidable work, and wasted context. For context, run
   `scripts/analyze-sessions.ts --help` and use its current interface.
3. For external tools, search GitHub Trending and current GitHub results for agent tools that solve the observed problems.
4. Rank ideas by lasting value, evidence, effort, and risk. Report the strongest first, each with its evidence, recurring benefit, and concrete
   direction. Mention rejected ideas only when the user is likely to consider them.

## Review areas

- **Context:** instructions and output that add tokens or make tasks harder to follow.
- **Skills:** gaps, duplication, outdated guidance, and work better handled by scripts.
- **Rules:** scope, duplication, and whether each rule lives in the right place.
- **Install and tooling:** `doctor` results and differences between source and installed configuration.
- **Active projects:** whether the active-project records are current.
- **External tools:** agent tools whose benefits justify adding and maintaining them.
