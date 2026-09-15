---
name: test-writing
description: Test audits, writing, and review.
---

## Test quality

- Add tests when important behavior is untested.
- Add a regression test only when it fails on the original bug and protects behavior that users or other code rely on.
- Keep tests for throwaway local, development, or test code out of Git unless that code supports a lasting need.
- Test behavior, not implementation details or the framework itself.
- Use the simplest type of test that proves the expected behavior. Use integration tests when the behavior depends on components working together.
- Mock external dependencies when needed, without reproducing the code's internal steps. Check function calls only when the call itself is required
  behavior.
- Keep tests that catch the intended failure and survive internal changes that preserve behavior.
- Never test non-user facing, like internal dev tools, dev pages, local only seeders or similar, if working on it and need verification make something temporary but never part of test suite.