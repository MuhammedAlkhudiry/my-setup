---
name: decision-log
description: Use to record, change, or prune product decisions in a project's `docs/DECISIONS.md`.
---

`docs/DECISIONS.md` holds the decisions a future change could reverse by mistake because the code cannot show why they were made. Agents read it
before every product change, so every line costs attention. Create it when the first decision needs a home.

## What gets an entry

Record a decision only when a plausible change, such as a fix, simplification, or new feature, would reverse it, and its reason is not visible in
the code, its tests, or its comments. Everything else has another home:

| Content                                              | Home                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| Thresholds, limits, timings, and how a feature works | Code constants and tests                                      |
| The bug or incident that led to a decision           | The pull request                                              |
| When something was chosen, shipped, or changed       | Git history                                                   |
| Release, deploy, and operations steps                | `RELEASE.md` through $prepare-release, or the operations docs |
| Postponed work, such as dropping retired tables      | `TECH_DEBT.md` through $tech-debt                             |
| Product terms                                        | The project's glossary                                        |

## Entry format

One bullet under its topic heading, in at most two lines: the current decision, then `because` or `so` and the reason that stays true.

```markdown
- Occurrences are computed, never stored ahead — so they survive edits and timezone changes.
```

- State the decision as it stands, without dates, owner attributions, or what it replaced.
- Name a value only when the value is the decision, such as storing location at city level; otherwise state the rule the code implements.
- Record a non-goal when someone would plausibly build it.
- When a decision changes, rewrite its entry. When it no longer constrains any change, delete it.

## Pruning

When asked to clean up the file, apply these rules to every entry. Before deleting content that belongs elsewhere, check that its home already
holds it and move it there when it does not. Report what moved where and what was deleted.
