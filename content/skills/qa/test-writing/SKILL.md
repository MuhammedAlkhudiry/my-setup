---
name: test-writing
description: Use when a change may add, change, or remove tests, including a bug fix that needs a regression test, or when deciding what to test or judging tests; to rate the whole setup use $verification-report.
---

## Test quality

- Add tests when important behavior is untested.
- Add a regression test only when it fails on the original bug and protects behavior that users or other code rely on.
- Test behavior, not implementation details or the framework itself.
- Use the simplest type of test that proves the expected behavior. Use integration tests when the behavior depends on components working together.
- Mock external dependencies when needed, without reproducing the code's internal steps. Check function calls only when the call itself is required
  behavior.
- Keep tests that catch the intended failure and survive internal changes that preserve behavior.
- Never commit tests for code users never reach, such as internal developer tools, development-only pages, and local or QA seeders. When verifying
  that code during a task, build something temporary and keep it out of the test suite and out of Git.

## Test volume

- Cover a bug with one regression test: the smallest test that fails without the fix, at the level where users or callers see the failure. Add
  another case only for a separate way the same bug can fail, not for variations of the same path.
- Extend an existing test before adding a new test file.
- Add no tests for changes without behavior, such as copy, docs, config values, formatting, renames, or deleted dead code.
- Keep the test diff in proportion to the fix. When added test lines exceed about one and a half times the changed production lines, trim them or
  state the reason in the pull request.
- Use the regression test itself to show the fix: run it once without the fix to see it fail. Do not add tests only to demonstrate a change.
- When a test is too slow for the suite's time budget, make it faster or remove it; do not raise the budget for code users never reach.
- When delegating work that may add tests, tell the agent to load $test-writing first.
