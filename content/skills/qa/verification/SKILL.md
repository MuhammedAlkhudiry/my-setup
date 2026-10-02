---
name: verification
description: Use before reporting any code change as done (feature, bug fix, merge, or delegated task) to run the project's checks, or to create or repair its `CHECKLIST.md`; to rate the setup use $verification-report.
---

## Workflow

1. If repo-root `CHECKLIST.md` exists, run its relevant commands.
2. Otherwise discover exact commands from project manifests, task runners, tool configuration, and installed help. Prefer one comprehensive repo-level
   command when it covers the required gate; exclude builds unless the project requires them for verification.
3. When the full suite is slow, run the tests that cover the changed files first, then the full suite once before finishing.
4. For changes users can see, prove the change works in the running app with a browser, simulator, or real request; passing tests alone do not
   prove it.
5. Before adding, changing, or deleting a test, load $test-writing. Never edit or delete an existing test to make a check pass unless the behavior it
   protects changed on purpose.
6. Keep task-specific checks outside `CHECKLIST.md`.
7. Create or repair `CHECKLIST.md` only when verification setup was requested; use [CHECKLIST.md](CHECKLIST.md) for its format.
8. For verification-only requests, report failures without editing. During implementation, fix task-related fallout and rerun until it passes or is
   blocked.
9. Report every relevant command as `PASS`, `FAIL`, or `BLOCKED`, with the evidence from step 4: a screenshot, response, or flow result.
