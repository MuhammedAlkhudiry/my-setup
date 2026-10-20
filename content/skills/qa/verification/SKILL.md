---
name: verification
description: Use before test changes, bug fixes, or code handoff, and to assess or repair verification.
---

## Select the guidance

- For test changes or review, read [test guidance](references/tests.md).
- For visible UI changes, read [screen and text coverage](references/screen-and-text-coverage.md).
- Only when asked to rate verification, read [assessment](references/assessment.md).
- Only when asked to create or repair the checklist, use [CHECKLIST.md](CHECKLIST.md). Consult its stage budgets when a check is slow.

## Verify changes

1. While editing, run tests for changed files. Before handoff, run `docs/runbooks/checklist.md`'s gate once and applicable conditional checks.
   Without a checklist, discover commands from manifests, task runners, configuration, and installed help. Prefer one repo-level command;
   include builds only when required.
2. Wrap heavy commands with `heavy-run --class checks -- mise run signoff`, using `benchmark` or `build` where appropriate.
   Keep independent stages parallel; light checks need no slot. Self-queuing runners declared in `package.json`'s
   `heavyRun.deferredCommands` reserve only their heavy steps. Builds, deferred runners, and `heavyRun.uncappedCommands` inherit no
   runtime cap, including nested steps; other checks/benchmarks die at 90 seconds (exit 124). Split or speed up capped work.
   See [deferred runs](references/heavy-run-deferred.md) for declarations and queue policy. Compare repeated benchmark runs or medians.
   Background long commands and device/server startups; use notifications, never a foreground polling loop.
3. Prove visible changes in the running app using $browser-simulator-routing. Use $guide-qa for step-by-step user inspection.
4. Run the full command before release. Run end-to-end journeys, mutation testing, coverage, packaging, and paid evals when requested;
   ask first for a large or risky check.
5. If a check exceeds [its stage budget](CHECKLIST.md#stage-budgets), speed it up, make it manual, or record a follow-up with $project-docs.
   Never raise the budget.
6. Never weaken or delete a test to pass a check unless its protected behavior changed intentionally. For verification-only requests,
   report failures without editing; during implementation, fix task-related fallout and rerun.
7. Keep task-specific checks outside the checklist. Commit and push only with the project's Git hooks installed.
8. Report `PASS`, `FAIL`, or `BLOCKED`, running-app evidence for visible changes, and unverified coverage.

## Test essentials

- Prefer types, lint rules, or static checks when they can catch the failure.
- Protect behavior and contracts, not coverage counts, implementation details, styles, copy, or framework behavior.
- When static checks cannot catch a fixed bug, add the smallest regression test that fails without the fix; extend an existing test first.
- Prefer integration tests with the real database and framework. Mock external boundaries, not the project's own modules.
- Keep tests independent, fast, and proportionate. Never sleep or call a real network. Keep disposable checks out of Git and the test suite.
