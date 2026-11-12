# Decisions

Read every decision in each area a change touches; `decisions search --full` prints whole files.

## What gets an entry

Record a decision when a plausible change could reverse it and code, tests, or comments cannot explain its reason. Record it as soon as it
rules out a change, even before implementation. Other content goes to its [home](../SKILL.md#homes); thresholds, limits, timings, and
how a feature works stay in code constants and tests, and when something was chosen stays in git history.

## Entry format

Use one or two lines in `docs/decisions/<area>/<slug>.md`: the current decision, then `because` or `so` and its lasting reason.

```markdown
Occurrences are computed, never stored ahead, so they survive edits and timezone changes.
```

- Name the folder for a product area using glossary terms; create an area only when none fits.
- Omit dates, owner attributions, and superseded choices.
- Name a value only when the value is the decision, such as storing location at city level; otherwise state the rule the code implements.
- Record a non-goal when someone would plausibly build it.
- When a decision changes, rewrite its file. When it no longer constrains any change, delete the file.

## Pruning

Keep a decision only when it constrains a plausible future change and someone would likely get that change wrong without it. Delete it when:

- code, tests, lint rules, or comments already make it obvious;
- a later decision or the current code supersedes it;
- it is a one-off implementation note, incident story, or dated history;
- its content belongs in another home, after that home holds it.

Merge near-duplicates into one file.
