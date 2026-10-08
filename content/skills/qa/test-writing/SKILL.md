---
name: test-writing
description: Use before adding, editing, or deleting any test file, before fixing a bug, and when judging or pruning tests; to rate the whole setup use $verification-report.
---

## What earns a test

- Prefer a type, lint rule, or static check when it can catch the failure; add a test only when none can.
- Add a test only when it protects a business rule, an input boundary, authorization, persisted data, a contract that other code or released clients
  rely on, user-visible state, or a fixed bug.
- Never add a test to raise coverage. Coverage shows untested code; it is not a target.
- Never commit tests for code users never reach, such as internal developer tools, development-only pages, and local or QA seeders. When verifying
  that code during a task, build something temporary and keep it out of the test suite and out of Git.

## Test quality

- Add a regression test only when it fails on the original bug and protects behavior that users or other code rely on.
- Test behavior, not implementation details or the framework itself.
- Test at the level where users or callers see the behavior. Prefer integration tests against the real database and framework over unit tests that
  isolate code with mocks.
- Mock only boundaries the project does not own, such as third-party services, time, randomness, and native platform modules. Do not mock the
  project's own modules to isolate a unit. Check calls only when the call itself is required behavior.
- Keep tests that catch the intended failure and survive internal changes that preserve behavior.

## Tests to reject

Do not write these, and remove them when found:

- Tests that only check a component renders or a value exists when a real result can be asserted.
- Tests that restate the implementation: styles, copy, asset paths, constants, enum labels, or formulas copied from the code.
- Serializer or resource shape tests that an endpoint test already covers.
- Tests whose assertions are mostly calls on mocks or internal call order.
- Tests that cannot fail or repeat another test's case.

## Test volume

- Cover a bug with one regression test: the smallest test that fails without the fix, at the level where users or callers see the failure. Add
  another case only for a separate way the same bug can fail, not for variations of the same path.
- Extend an existing test before adding a new test file.
- Add no tests for changes without behavior, such as copy, docs, config values, formatting, renames, or deleted dead code.
- Keep the test diff in proportion to the fix. When added test lines exceed about one and a half times the changed production lines, trim them or
  state the reason in the pull request.
- Use the regression test itself to show the fix: run it once without the fix to see it fail. Do not add tests only to demonstrate a change.
- When delegating work that may add tests, tell the agent to load $test-writing first.

## Test speed

Speed is a requirement: every later task runs the suite locally and in CI.

- Keep a unit test to milliseconds and an integration test under about half a second.
- Never sleep or call a real network; use fake timers and fakes. Seed only the data the test reads.
- Keep tests independent so they run in parallel. Time each new or changed test file before reporting.
- When a suite exceeds its stage budget in $verification, speed up or remove its slowest tests or record a follow-up with $project-docs; never
  raise the budget.
- Run end-to-end journeys, device flows, mutation testing, and coverage only as manual commands before a release.

## Pruning

When asked to prune a suite, remove tests that match [Tests to reject](#tests-to-reject) in small batches, one area per batch. Before removing a
test, confirm its behavior is covered elsewhere or not worth protecting. Where the project runs mutation testing, keep any test whose removal lets a
mutant survive. Run the suite after each batch and list each removed file with its reason.
