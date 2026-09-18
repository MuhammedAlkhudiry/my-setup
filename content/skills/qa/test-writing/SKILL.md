---
name: test-writing
description: Use when deciding what to test or writing, changing, or judging tests; to rate the whole setup use $verification-report.
---

## Test quality

- Add tests when important behavior is untested.
- Add a regression test only when it fails on the original bug and protects behavior that users or other code rely on.
- Test behavior, not implementation details or the framework itself.
- Use the simplest type of test that proves the expected behavior. Use integration tests when the behavior depends on components working together.
- Mock external dependencies when needed, without reproducing the code's internal steps. Check function calls only when the call itself is required
  behavior.
- Keep tests that catch the intended failure and survive internal changes that preserve behavior.
- Never commit tests for code users never reach, such as internal developer tools, development-only pages, and local seeders. When verifying that code
  during a task, build something temporary and keep it out of the test suite and out of Git.
