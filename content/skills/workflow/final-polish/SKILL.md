---
name: final-polish
description: Check and improve completed work before human review.
---

## Workflow

1. Review the diff for unnecessary changes, test quality, regressions, and mismatches between connected components. Fix or report behavior that is
   broken, unsafe, outdated, or unclear.
2. Run $simplify in a subagent started from a self-contained brief with the exact scope, evaluating each pass before the next. Run $test-writing to
   audit coverage and close approved worthwhile gaps. These passes may edit.
3. Run these read-only reviews of the same scope in parallel, each in a subagent started from its own self-contained brief:
   - $code-review as a Standards review.
   - $refactor-opportunities.
   - $ux-ui when the diff affects an interface; inspect the rendered result or report `BLOCKED`. Report unavailable passes instead of simulating them.
4. Use $verification to check the final result. Fix failures caused by the task and report each check as `PASS`, `FAIL`, or `BLOCKED`.
5. Run one final read-only review in a subagent with a self-contained brief. The main agent combines the findings and writes the final report.

## Rules

- Give each subagent its full scope and context in the brief and tell it to treat inherited conversation as background, not as the task.
- Include every report section and state empty, skipped, unavailable, or blocked results.
- Use `READY FOR HUMAN REVIEW` only when no blocker remains.

## Report template

```md
# <READY FOR HUMAN REVIEW | NOT READY FOR HUMAN REVIEW>

## Simplify

- **Applied:** <items or none>
- **Suggested:** <items or none>

## Refactor opportunities

- **<Recommended | Optional>: <problem>** (`<files>`)
  - **Impact:** <impact>

<or "No worthwhile refactor opportunities found">

## Code review

<$code-review output>

## UI/UX review

- **<issue>**
  - **User goal:** <goal>
  - **Current:** <behavior>
  - **Fix:** <recommended behavior>
  - **Reason:** <reason>

<or "No findings", "Skipped", or "Blocked: <reason>">

## Final review

<use the $code-review finding format, or "Clear">

## Verification

- `<check>` — <PASS | FAIL | BLOCKED>
```
