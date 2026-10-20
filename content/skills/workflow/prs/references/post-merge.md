# Post-merge steps

Confirm the change landed correctly. Run only the steps that apply to this PR, using the project's runbooks for deploys, production access,
and Sentry, and report which ran and their results. Docs, tests, tooling, and agent-instruction PRs need only step 1.

1. **CI:** run `bun <skill-dir>/scripts/postmerge-check.ts <pr-url|merge-sha> --repo <owner/repo|checkout> --workflow <name> --timeout 600 --json`.
   `<skill-dir>` is the installed $prs directory. This checks the exact merge commit's push workflow and is the bounded fallback when the
   harness cannot watch it. Exit 75: resume before proceeding. See `--help` for options and receipt details.
2. **Deploy:** when the merge deploys a server, website, or over-the-air update, wait for that deploy of the exact merge commit to finish,
   then confirm production serves it and its health check passes.
3. **Migrations:** when the PR adds migrations, confirm production ran each one and recorded no failure.
4. **Jobs and config:** when the PR changes queued jobs, scheduled commands, or environment config, confirm workers restarted onto the new
   code and the next run or a live read succeeds.
5. **Errors:** when the PR changes app or server behavior, check Sentry 5 minutes after the deploy goes live for new or regressed issues in
   the changed area and for an error-rate jump.

On a failure, inspect it, then fix forward or deliberately revert; never revert automatically.
