# Runner outage recovery

If CI stays queued, inspect [Ubicloud status](https://status.ubicloud.com/) and the project's CI runbook. For a runner provisioning incident,
run `ci-runner status`, then `ci-runner github` to set `CI_RUNNER=ubuntu-24.04` for all active projects. GitHub-hosted fallback spends
GitHub Actions minutes; keep Ubicloud as the default. Commands support `--json` and `--verbose`; a failure reports each affected repository
with its full log. A partial switch needs inspection before continuing.

Already queued jobs retain their selected runner. Dispatch a fresh main run with
`gh workflow run ci.yml --ref main --repo <owner/repo>` and track that run separately. Do not dispatch work-in-progress checks. The original
merge push's postmerge-check receipt stays separate. During the outage, a later successful main run can confirm earlier queued merges:
verify each merge commit is an ancestor of that run's commit and report both run links. Read the project runbook before cancelling or
rerunning an older workflow, especially one that deploys.

After Ubicloud's status page marks the runner incident resolved, run `ci-runner ubicloud` to delete both repository overrides, then `ci-runner status` to confirm restoration.
Setting or deleting the variables does not trigger a run.
