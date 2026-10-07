---
name: verification
description: Use before reporting any code change as done (feature, bug fix, merge, or delegated task) to run the project's checks, or to create or repair its `docs/runbooks/checklist.md`; to rate the setup use $verification-report.
---

## Workflow

1. While editing, run only the tests that cover the changed files.
2. Before reporting, run the gate command from `docs/runbooks/checklist.md` once, plus the conditional lines the change matches. Without a
   checklist, discover exact commands from project manifests, task runners, tool configuration, and installed help; prefer one repo-level command,
   and exclude builds unless the project requires them for verification.
3. Run separate checks through the task runner's parallel form, such as `mise run a ::: b`; never loop through tasks one at a time.
4. Run any command longer than about two minutes in the background with a completion notification, not in a polling loop.
5. Run the full command, end-to-end journeys, packaging, and paid evals only before a release or when asked.
6. For changes users can see, prove the change works in the running app with a browser, simulator, or real request; passing tests alone do not
   prove it.
7. Before adding, changing, or deleting a test, load $test-writing. Never edit or delete an existing test to make a check pass unless the behavior it
   protects changed on purpose.
8. Commit and push from a worktree of the main clone, or from a clone with the project's Git hooks installed, so the hooks run.
9. Keep task-specific checks outside the checklist.
10. Create or repair the checklist only when verification setup was requested; use [CHECKLIST.md](CHECKLIST.md) for its format and stage budgets.
11. For verification-only requests, report failures without editing. During implementation, fix task-related fallout and rerun until it passes or is
    blocked.
12. Report every relevant command as `PASS`, `FAIL`, or `BLOCKED`, with the evidence from step 6: a screenshot, response, or flow result.
