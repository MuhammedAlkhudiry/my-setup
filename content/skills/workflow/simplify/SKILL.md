---
name: simplify
description: Use to simplify completed work; use $code-review to judge correctness.
---

## Workflow

1. Use the requested scope or current `git diff`; trace callers and required behavior.
2. Remove unnecessary code and abstractions within scope only with evidence that behavior and operational properties are preserved.
   Reduce nesting; never add nested ternaries. Prefer direct implementations, reorganizing files when needed. Keep decisions local unless
   sharing or configuration is necessary.
3. Recommend without applying changes that alter required behavior, expand scope, need a migration, involve meaningful trade-offs, or cannot be verified.
   Consider implementation and user experience.
4. Use $laravel or $react for framework changes and $verification for test changes. After approval, use $workshop for unresolved product
   decisions and $ux-ui for product or UX changes.
