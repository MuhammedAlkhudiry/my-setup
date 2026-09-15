---
name: simplify
description: Simplify completed work through safe edits and recommendations.
---

## Workflow

1. Use the requested scope or the current `git diff`, then trace how the changed code is used and which behavior it must preserve.
2. Simplify within scope when evidence shows that required behavior and operational properties will be preserved. Remove unnecessary code and
   abstractions.
3. Reduce nesting and never add nested ternaries. Aim for the simplest direct implementation, reorganizing files when needed. Keep decisions local
   unless sharing or configuration is necessary.
4. Recommend rather than apply changes that alter required behavior, expand scope, need a migration, introduce a meaningful trade-off, or cannot be
   verified. Consider both the implementation and the user experience. Exclude style preferences and unsupported guesses.
5. Classify each suggestion as `Recommended` or `Optional`, then report its area, affected files or flow, proposed simplification, expected benefit,
   reason it was not applied, what could be lost, supporting evidence, and required decision or validation. If none exist, report
   `No suggested simplifications found`.
6. Use $react for React changes and $test-writing when changing tests. After approval, use $workshop for unresolved product decisions and $ux-ui for
   product or UX changes.
