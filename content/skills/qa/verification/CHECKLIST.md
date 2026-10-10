# Verification Checklist

`docs/runbooks/checklist.md` is a short command list of about 30 lines:

```text
# Before reporting: the areas this branch changed, in parallel
mise run check

# After the final push to a pull request: what its CI would run, then a green signoff status on GitHub
mise run signoff

# Before a release: every area
mise run premerge

# One test file
cd app && bunx jest <path>

# When a route changes
mise run api:check
```

- Replace every example with commands confirmed from the project and installed tool help.
- Use `#` comments for group labels and conditions. Put explanations in the task runner's descriptions, not in the checklist.
- Give the project one gate command that runs the checks for the areas the branch changed, in parallel, and fixes formatting.
- Give it one full command that runs every area and everything CI runs.
- Give each test runner an iterate command that runs only the tests the change affects, through the runner's impact analysis where it has
  one, such as Pest `--tia` or Jest `--findRelatedTests`.
- Keep pull request CI to the checks for the changed areas. Keep end-to-end journeys, mutation testing, coverage, and paid evals out of it.
- When pull requests use local sign-off instead of CI, give the project a sign-off command. It refuses uncommitted or unpushed work, runs
  everything pull request CI would for the changed areas, and posts a green or red `signoff` commit status. Keep cloud CI on the main
  branch, where it catches what the developer machine cannot, such as case-sensitive file names on Linux.
- Let the gate and the sign-off skip a check that already passed on identical code, installed dependencies, and CI mode, and give them a
  flag that reruns everything. Generators that other checks read run whenever anything else runs. The full command always runs everything.
- Make every command safe to run from several worktrees at once: derive test database names, ports, and caches from the worktree, so
  parallel runs never drop or reuse each other's data.
- Include every required verification category, not only tests and lint. Include builds only when the project treats them as part of its gate.
- Keep paid evals, coverage reports, profilers, and release-only steps out of the checklist.

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
