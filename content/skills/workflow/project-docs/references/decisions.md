# Decisions

A decision file holds a decision that a future change could reverse by mistake because the code cannot show why it was made. Agents read every
decision in the areas a change touches, so every line costs attention.

## What gets an entry

Record a decision only when a plausible change, such as a fix, simplification, or new feature, would reverse it, and its reason is not visible
in the code, its tests, or its comments. Record it when it is made, even before it is built, if it already rules out a change, such as never
selling coins. Everything else has another home:

| Content                                              | Home                         |
| ---------------------------------------------------- | ---------------------------- |
| Thresholds, limits, timings, and how a feature works | Code constants and tests     |
| The bug or incident that led to a decision           | The pull request             |
| When something was chosen, shipped, or changed       | Git history                  |
| Release, deploy, and operations steps                | Release entries or a runbook |
| Postponed work, such as dropping retired tables      | Tech-debt entries            |
| Product terms                                        | The glossary                 |

## Entry format

`docs/decisions/<area>/<slug>.md` holds one or two lines: the current decision, then `because` or `so` and the reason that stays true.

```markdown
Occurrences are computed, never stored ahead, so they survive edits and timezone changes.
```

- Name the area folder after a product area in the glossary's words. Create a new area only when no existing one fits.
- State the decision as it stands, without dates, owner attributions, or what it replaced.
- Name a value only when the value is the decision, such as storing location at city level; otherwise state the rule the code implements.
- Record a non-goal when someone would plausibly build it.
- When a decision changes, rewrite its file. When it no longer constrains any change, delete the file.

## Pruning

When asked to clean up decisions, apply these rules to every file. Before deleting content that belongs elsewhere, check that its home already
holds it and move it there when it does not. Report what moved where and what was deleted.
