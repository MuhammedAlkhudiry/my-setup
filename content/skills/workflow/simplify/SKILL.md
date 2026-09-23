---
name: simplify
description: "Use to make completed work simpler: applies safe edits in scope and recommends the rest; to judge correctness use $code-review."
---

## Workflow

1. Use the requested scope or the current `git diff`, then trace how the changed code is used and which behavior it must preserve.
2. Simplify within scope when evidence shows that required behavior and operational properties will be preserved. Remove unnecessary code and
   abstractions.
3. Reduce nesting and never add nested ternaries. Aim for the simplest direct implementation, reorganizing files when needed. Keep decisions local
   unless sharing or configuration is necessary.
4. Recommend rather than apply changes that alter required behavior, expand scope, need a migration, introduce a meaningful trade-off, or cannot be
   verified. Consider both the implementation and the user experience.
5. Use $laravel or $react for framework changes and $test-writing when changing tests. After approval, use $workshop for unresolved product decisions and $ux-ui for
   product or UX changes.

## Recommended, not applied

Report every change you did not apply, including structural improvements that reach beyond the diff: module boundaries, duplication across files, and
responsibilities in the wrong place. Inspect the relevant callers, tests, and contracts before recommending one.

Recommend a change only when it solves an observed problem. Exclude style preferences, unsupported guesses, and abstractions with no current need.

Classify each item as `Recommended` or `Optional`, then give its area, affected files or flow, proposed change, expected benefit, reason it was not
applied, what could be lost, supporting evidence, and the decision or validation it needs.

If nothing is worthwhile, report `No suggested simplifications found`.
