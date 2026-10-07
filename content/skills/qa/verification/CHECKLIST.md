# Verification Checklist

`docs/runbooks/checklist.md` is a short command list of about 30 lines:

```text
# Before reporting: the areas this branch changed, in parallel
mise run check

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
- Include every required verification category, not only tests and lint. Include builds only when the project treats them as part of its gate.
- Keep paid evals, coverage reports, profilers, and release-only steps out of the checklist.

## Stage budgets

| Stage           | Runs                                        | Budget                 |
| --------------- | ------------------------------------------- | ---------------------- |
| Iterate         | Tests for the changed files                 | Seconds                |
| Gate            | The gate command, once before reporting     | About 2 minutes        |
| Pre-commit hook | Formatters on staged files                  | 2 seconds              |
| Pre-push hook   | Fast static checks and tests for the change | 15 seconds             |
| CI              | Every check for the changed areas           | Not waited on mid-task |
| Full            | The full command                            | Before a release       |
