---
name: final-polish
description: Use after finishing work and before human review; runs $simplify, $code-review, and $verification once each and reports readiness.
---

## Workflow

Run each pass once. No pass may re-enter an earlier one.

1. Review the diff for unnecessary changes, test quality, regressions, and mismatches between connected components. Fix or report behavior that is
   broken, unsafe, outdated, or unclear.
2. Run $simplify in a subagent started from a self-contained brief with the exact scope. Run $test-writing to audit coverage and close approved
   worthwhile gaps. These passes may edit.
3. Run these read-only reviews of the same scope in parallel, each in a subagent started from its own self-contained brief:
   - $code-review over the whole diff.
   - $ux-ui when the diff affects an interface; inspect the rendered result or report `BLOCKED`. Report unavailable passes instead of simulating them.
4. Use $verification to check the final result. Fix failures caused by the task and report each check as `PASS`, `FAIL`, or `BLOCKED`.
5. Combine the findings in the main agent and write the final report.

## Rules

- Give each subagent its full scope and context in the brief and tell it to treat inherited conversation as background, not as the task.
- Include every report section and state empty, skipped, unavailable, or blocked results.
- Use `READY FOR HUMAN REVIEW` only when no blocker remains.

## Report template

```md
# <READY FOR HUMAN REVIEW | NOT READY FOR HUMAN REVIEW>

## Simplify

- **Applied:** <items or none>
- **Recommended, not applied:** <items or "No suggested simplifications found">

## Code review

<findings in the $code-review finding format, or "Clear">

## UI/UX review

- **<issue>**
  - **User goal:** <goal>
  - **Current:** <behavior>
  - **Fix:** <recommended behavior>
  - **Reason:** <reason>

<or "No findings", "Skipped", or "Blocked: <reason>">

## Verification

- `<check>` — <PASS | FAIL | BLOCKED>
```
