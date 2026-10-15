---
name: verification
description: Use before changing tests, fixing bugs, or reporting code changes as done; also use to assess or repair project verification.
---

## Select the guidance

- Before adding, changing, deleting, judging, or pruning tests, read [test guidance](references/tests.md).
- For visible UI changes, use [screen and text coverage](references/screen-and-text-coverage.md) on the affected journeys.
- When asked to rate the verification setup, read [assessment](references/assessment.md); do not run an assessment for ordinary changes.
- When asked to create or repair the project's checklist, use [CHECKLIST.md](CHECKLIST.md) for its format and stage budgets.

## Verify changes

1. While editing, run only the tests that cover changed files.
2. Before reporting, run the gate from `docs/runbooks/checklist.md` once, plus applicable conditional checks. Without a checklist, discover
   commands from manifests, task runners, tool configuration, and installed help. Prefer one repo-level command; include builds only when
   the project requires them.
3. On hosts with `heavy-run`, wrap full gates/sign-offs, benchmarks, native builds, and renders once: `heavy-run --class checks -- mise run signoff`,
   or class `benchmark` or `build`; keep independent stages parallel inside it. Light checks need no slot; exit 75 means no child started.
   Run long commands, builds, and device or server startups in the background and act on the notification; never wait in a foreground
   loop that sleeps or rereads their output.
4. Prove visible changes in the running app through a browser, simulator, or real request using $browser-simulator-routing. Passing tests
   alone do not prove them. Use $guide-qa when the user wants to inspect the result step by step.
5. Run the full command before a release. Run end-to-end journeys, mutation testing, coverage, packaging, and paid evals when requested;
   ask first for a large or risky check.
6. A check over its stage budget in [CHECKLIST.md](CHECKLIST.md) is a defect: speed it up, make it manual, or record a follow-up with
   $project-docs. Never raise the budget.
7. Never weaken or delete an existing test to make a check pass unless its protected behavior changed on purpose. For verification-only
   requests, report failures without editing; during implementation, fix task-related fallout and rerun.
8. Keep task-specific checks outside the checklist. Create or repair the checklist only when requested. Commit and push from a checkout
   with the project's Git hooks installed.
9. Report checks as `PASS`, `FAIL`, or `BLOCKED`, with running-app evidence for visible changes and any unverified coverage.

## Test essentials

- Prefer types, lint rules, or static checks when they can catch the failure.
- Protect meaningful behavior and contracts, not coverage counts, copied implementation, styles, copy, or framework behavior.
- Cover a fixed bug with the smallest regression test that fails without the fix; extend an existing test before adding a file.
- Prefer integration tests with the real database and framework. Mock external boundaries, not the project's own modules.
- Keep tests independent, fast, and proportionate. Never sleep or call a real network. Keep disposable checks out of Git and the test suite.
