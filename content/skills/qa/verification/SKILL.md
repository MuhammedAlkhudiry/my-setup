---
name: verification
description: Use before test changes, bug fixes, or code handoff, and to assess or repair verification.
---

## Select the guidance

- For test changes, bug fixes, or test review, read [test guidance](references/tests.md).
- For visible UI changes, read [screen and text coverage](references/screen-and-text-coverage.md).
- Only when asked to rate verification, read [assessment](references/assessment.md).
- Only when asked to create or repair the checklist, use [CHECKLIST.md](CHECKLIST.md). Consult its stage budgets when a check is slow.

## Verify changes

1. Run narrow changed-file tests and static checks first. Before handoff, run `docs/runbooks/checklist.md`'s gate once and applicable conditional checks.
   Without a checklist, discover commands from manifests and task runners. Prefer one repo-level command; include builds only when required.
2. Run gates directly, such as `mise run check`, and sign-offs as PR-CHECKS describes. Other agents share the Mac, so compare repeated
   benchmark runs or medians.
3. Prove visible changes in the running app using $browser-simulator-routing. Use $guide-qa for step-by-step user inspection.
4. Run the full command before release. Run end-to-end journeys, mutation testing, coverage, packaging, and paid evals when requested;
   ask first for a large or risky check.
5. If a check exceeds [its stage budget](CHECKLIST.md#stage-budgets), speed it up, make it manual, or record a follow-up with $project-docs.
   Never raise the budget.
6. Never weaken or delete a test to pass a check unless its protected behavior changed intentionally. For verification-only requests,
   report failures without editing; during implementation, fix task-related fallout and rerun.
7. Keep task-specific checks outside the checklist. Commit and push only with the project's Git hooks installed.
8. Report `PASS`, `FAIL`, or `BLOCKED`, running-app evidence for visible changes, and unverified coverage.
