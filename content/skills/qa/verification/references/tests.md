# Tests

## What earns a test

- Prefer a type, lint rule, or static check when it can catch the failure; add a test only when none can.
- Add a test only when it protects business rules, input boundaries, authorization, persisted data, caller/client contracts, user-visible state,
  or a fixed bug.
- Coverage locates untested code; never add tests to raise it.
- Never commit tests for code users never reach, such as development-only pages, local or QA seeders, and disposable task scripts; verify those
  with something temporary outside Git. Maintained tooling with operational consequences, such as worktree cleanup or device queues, still
  earns behavioral tests.

## Test quality

- Test where users or callers observe behavior. Prefer integration tests with the real database and framework over isolated units.
- Mock external boundaries, such as services, time, randomness, and native modules, not the project's own modules. Assert calls only when the
  call itself is required behavior.
- Tests must catch the intended failure and survive internal changes that preserve behavior.

## Tests to reject

Reject these; remove existing ones using [Pruning](#pruning):

- Render/existence checks when a real result can be asserted.
- Assertions that repeat styles, copy, asset paths, constants, enum labels, or formulas from the implementation, or test the framework itself.
- Serializer/resource shape tests already covered by an endpoint test.
- Assertions mostly on mocks or internal call order.
- Tests that cannot fail or duplicate another case.

## Test volume

- When a regression test is warranted, use the smallest case that fails on the original bug and protects behavior users or callers rely on.
  Run it without the fix to prove this. Add cases only for distinct failure paths.
- Extend an existing test before adding a file.
- Add no tests for changes without behavior: copy, docs, config values, formatting, renames, or dead-code removal.
- If added test lines exceed about 1.5 times changed production lines, trim them or explain why in the pull request.
- When delegating work that may add tests, tell the agent to load $verification first.

## Test speed

- Keep a unit test to milliseconds and an integration test under about half a second.
- Never sleep or call a real network; use fake timers and fakes. Seed only data the test reads.
- Keep tests independent so they run in parallel. Time each new or changed test file before reporting.
- If a suite exceeds [its stage budget](../CHECKLIST.md#stage-budgets), speed up or prune slow tests, or record a follow-up with $project-docs.
  Never raise the budget.
- Run end-to-end journeys, device flows, mutation testing, and coverage only as manual commands before a release.

## Pruning

When asked to prune, remove rejected tests in small batches, one area at a time. Confirm each behavior is covered elsewhere or not worth protecting.
If the project runs mutation testing, retain tests whose removal lets a mutant survive. Run the suite after each batch; list removed files and reasons.
