# Release actions

`docs/release/<slug>.md` lists the actions one change needs that a deploy does not perform, such as store builds, outside sign-off, or one-time
commands. Record it on the same branch as the change, so merging the code merges its reminder.

```markdown
# <Change>

<What the change does to production, and what goes wrong if the steps are skipped.>

- [ ] <Action>, <when it can run: after deploy, once iOS 1.5.2 is on sale, after 2026-10-15>. <Command, or a link to where it is documented.>

Complete when <a check anyone can run>. Roll back by <steps>, or <why it cannot be rolled back>.
```

- Name each item's trigger so it can be checked later. An item that waits on an outside event names that event.
- When the release creates temporary code or setup, record its cleanup as a tech-debt entry with its trigger and the evidence that removal is safe.
- Mark a finished item `[x]` with its date and result. Delete the file once every item is done; git history keeps the record. Before deleting,
  move any lasting lesson it taught, such as a store status that does not prove a build is live, into the matching runbook.

## Checking pending actions

Before any release or deploy, and when asked for pending release work, read every file in `docs/release/`. Check each open item's trigger
against its real source, such as store status, the live API, analytics, or the deploy log. Report each item as due now, waiting on a named
event, or done. Mark done items and delete completed files.
