---
name: refactor-opportunities
description: Recommend structural code improvements after changes, without editing.
---

## Workflow

1. Use the requested scope or current diff, then inspect the relevant callers, tests, and contracts.
2. Recommend structural changes only when they solve an observed problem. Exclude style preferences and abstractions without a current need.
3. Classify each item as `Recommended` or `Optional`.
4. For each item, name the affected files, structural problem, and impact.
5. If nothing is worthwhile, report `No worthwhile refactor opportunities found`.
