# Verification Checklist

Keep `docs/runbooks/checklist.md` to about 30 lines of confirmed project commands:

```text
# Before reporting: the areas this branch changed, in parallel
heavy-run --class checks -- mise run check

# After the final PR push: CI-equivalent checks and a GitHub signoff status
heavy-run --class checks -- mise run signoff

# Before a release: every area
heavy-run --class checks -- mise run premerge

# One test file
cd app && bunx jest <path>

# When a route changes
mise run api:check
```

- Replace examples using project configuration and installed help. Use `#` comments for groups/conditions; put explanations in task descriptions.
- Wrap heavy commands at the outer level; opted-in cooperating runners reserve each heavy step. Run individual test files and light checks
  directly. Deferred runners and their heavy steps are uncapped; declare other gate prefixes in `heavyRun.uncappedCommands` for the same exemption.
  Ad-hoc checks/benchmarks must finish within 90 seconds: split or speed them up. Builds are exempt. See $verification.
  Benchmarks share the host with other jobs; timings can be noisy, so compare repeated runs or medians.
- Provide one gate for changed areas, running independent checks in parallel and fixing formatting; one full command for all areas and CI checks;
  and an iterate command per test runner, using impact analysis when available, such as Pest `--tia` or Jest `--findRelatedTests`.
- Limit PR CI to changed areas. Exclude end-to-end journeys, mutation testing, coverage, and paid evals.
- When local sign-off replaces PR CI, its command must refuse uncommitted/unpushed work, run CI-equivalent checks for changed areas, and post a
  green/red `signoff` commit status. Retain main-branch cloud CI for platform differences, such as Linux filename case sensitivity.
- Gate/sign-off may reuse results only for identical code, installed dependencies, and CI mode; provide a force-rerun flag. Run generators consumed
  by checks whenever anything else runs. The full command never skips checks.
- Isolate test databases, ports, and caches per worktree so concurrent commands cannot reuse or drop each other's data.
- Include every required verification category; include builds only when part of the project's gate.
- Exclude paid evals, coverage reports, profilers, and release-only steps from the checklist.

## Stage budgets

| Stage           | Runs                                        | Budget                                  |
| --------------- | ------------------------------------------- | --------------------------------------- |
| Iterate         | Tests for the changed files                 | Seconds                                 |
| Gate            | The gate command, once before reporting     | Under 2 minutes                         |
| Pre-commit hook | Formatters on staged files                  | 2 seconds                               |
| Pre-push hook   | Fast static checks and tests for the change | 15 seconds                              |
| Sign-off        | The sign-off command, on the pushed head    | Under 2 minutes                         |
| CI              | Every check for the changed areas           | Under 5 minutes; not waited on mid-task |
| Full            | The full command and the manual checks      | Before a release                        |
