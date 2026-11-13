---
name: verification
description: Use before test changes, bug fixes, or code handoff, and to assess or repair verification.
---

## Select the guidance

- For test changes, bug fixes, or test review, read [test guidance](references/tests.md).
- For visible UI changes, read [screen and text coverage](references/screen-and-text-coverage.md).
- Only when asked to rate verification, read [assessment](references/assessment.md).

## Verify changes

1. Run narrow changed-file tests and static checks first. Before handoff, run the project's gate once, such as `mise run check`; find
   commands with `mise tasks`, or from manifests and task runners without mise. Include builds only when required.
2. Run gates directly, such as `mise run check`, and sign-offs as PR-CHECKS describes. Other agents share the Mac, so compare repeated
   benchmark runs or medians.
3. Prove visible changes in the running app using $browser-simulator-routing. Use $guide-qa for step-by-step user inspection.
4. Run the full command before release. Run end-to-end journeys, mutation testing, coverage, packaging, and paid evals when requested;
   ask first for a large or risky check.
5. If a check exceeds [its stage budget](#stage-budgets), speed it up, make it manual, or record a follow-up with $project-docs.
   Never raise the budget.
6. Never weaken or delete a test to pass a check unless its protected behavior changed intentionally. For verification-only requests,
   report failures without editing; during implementation, fix task-related fallout and rerun.
7. Keep task-specific checks out of the project's gate. Commit and push only with the project's Git hooks installed.
8. Report `PASS`, `FAIL`, or `BLOCKED`, running-app evidence for visible changes, and unverified coverage.

## Stage budgets

| Stage           | Runs                                        | Budget           |
| --------------- | ------------------------------------------- | ---------------- |
| Iterate         | Tests for the changed files                 | Seconds          |
| Gate            | The gate command, once before reporting     | Under 2 minutes  |
| Pre-commit hook | Formatters on staged files                  | 2 seconds        |
| Pre-push hook   | Fast static checks and tests for the change | 15 seconds       |
| Sign-off        | The sign-off command, on the final head     | Under 2 minutes  |
| Full            | The full command and the manual checks      | Before a release |
