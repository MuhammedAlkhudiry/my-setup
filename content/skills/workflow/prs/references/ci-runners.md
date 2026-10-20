# Runner outage recovery

If CI stays queued, inspect [Ubicloud status](https://status.ubicloud.com/) and the project's CI runbook. For a runner provisioning incident,
run `ci-runner status`, then `ci-runner github` for all active projects. The fallback spends GitHub Actions minutes; keep Ubicloud as the
default. Inspect any partial switch before continuing; see `ci-runner --help` for command details.

Already queued jobs retain their selected runner. Dispatch a fresh main run with
`gh workflow run ci.yml --ref main --repo <owner/repo>` and track that run separately. Do not dispatch work-in-progress checks. The original
merge push's postmerge-check receipt stays separate. A later successful main run can confirm earlier queued merges during the outage:
verify each merge commit is an ancestor of that run's commit and report both run links. Read the project runbook before cancelling or
rerunning an older workflow, especially one that deploys.

Only after the status page marks the incident resolved, run `ci-runner ubicloud`, then `ci-runner status` to confirm restoration.
Switching runners does not trigger a run.
