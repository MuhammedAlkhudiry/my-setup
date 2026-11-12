# Post-merge steps

<!-- profile:personal -->

The Housekeeper's Ops keeper runs these batch checks as its role describes; the owning thread checks only what its PR changed. In
`merge-queue status --json`, the `deploys` record shows whether the worker deployed, skipped, or failed a SHA.

<!-- /profile -->

Confirm the changes landed correctly. Run only the steps that apply to this PR, using the project's runbooks for deploys, production access,
and error tracking, and report which ran and their results.

<!-- profile:work -->

First confirm the exact merge commit's main CI pipeline passed; docs, tests, tooling, and agent-instruction PRs need only that.

<!-- /profile -->

1. **Deploy:** when the merge deploys a server, website, or over-the-air update, confirm the deploy of the exact merge commit finished,
   production serves it, and its health check passes.
   <!-- profile:personal -->
   The merge queue deploys each batch; a skipped deploy needs no further check. After fixing a failed one, run `merge-queue retry-deploy <owner/repo>`.
   <!-- /profile -->
2. **Migrations:** when the PR adds migrations, confirm production ran each one and recorded no failure.
3. **Jobs and config:** when the PR changes queued jobs, scheduled commands, or environment config, confirm workers restarted onto the new
   code and the next run or a live read succeeds.
4. **Errors:** when the PR changes app or server behavior, check the error tracker the project's runbook names (such as a PostHog
   error-tracking query for the backend, or Sentry for apps) 5 minutes after the deploy goes live for new or regressed issues in the
   changed area and for an error-rate jump.

On a failure, inspect it, then fix forward or deliberately revert; never revert automatically.
