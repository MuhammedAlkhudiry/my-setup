# Release actions

Record actions a deploy does not perform in `docs/release/<slug>.md` on the change's branch: store builds, outside sign-off, or one-time commands.

```markdown
# <Change>

<What the change does to production, and what goes wrong if the steps are skipped.>

- [ ] <Action>, <when it can run: after deploy, once iOS 1.5.2 is on sale, after 2026-10-15>. <Command, or a link to where it is documented.>

Complete when <a check anyone can run>. Roll back by <steps>, or <why it cannot be rolled back>.
```

- Name each item's trigger, including any outside event it waits on.
- When the release creates temporary code or setup, record its cleanup as a tech-debt entry with its trigger and the evidence that removal is safe.
- Mark finished items `[x]` with date and result.

## Checking pending actions

Before a release or deploy, or when asked for pending release work, read every file in `docs/release/`. Check open triggers against real sources.
Report each as due now, waiting on a named event, or done. Mark done items and delete completed files.

## Pruning

Once the release is public in every store it targets and its ship steps are done, move lasting lessons into the matching runbook, move items
that wait on later events into tech-debt entries, and delete the file. Only runbooks outlive a release.
