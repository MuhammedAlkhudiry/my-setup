# Verification Checklist

Keep `docs/runbooks/checklist.md` to about 30 lines of confirmed project commands:

```text
# Before reporting: the areas this branch changed, in parallel
mise run check

# After the final PR push: changed-area checks and a GitHub signoff status
mise run signoff

# Before a release: every area
mise run premerge

# One test file
cd app && bunx jest <path>

# When a route changes
mise run api:check
```

Where spare Macs take sign-offs, agents run `verify signoff`, which runs the project's sign-off on the least-loaded one.

- Replace examples using project configuration and installed help. Use `#` comments for groups/conditions; put explanations in task descriptions.
- Benchmarks share the Mac with other agents' jobs; timings can be noisy, so compare repeated runs or medians. See $verification.
- Provide one gate for changed areas, running independent checks in parallel and fixing formatting; one full command for all areas and CI checks;
  and an iterate command per test runner, using impact analysis when available, such as Pest `--tia` or Jest `--findRelatedTests`.
- Limit PR CI to changed areas. Exclude end-to-end journeys, mutation testing, coverage, and paid evals.
- When local sign-off replaces PR CI, its command must refuse uncommitted/unpushed work, run CI-equivalent checks for changed areas, and post a
  green/red `signoff` commit status.
- Sign-off runs only the stages a changed path can affect, including dependents such as generated clients, shared fixtures, and build inputs.
  Unknown paths, runner scripts, and tool versions select every stage. List the path-to-stage mapping in the checklist. `--full` runs every
  stage; merge-queue batch verification always passes it.
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
