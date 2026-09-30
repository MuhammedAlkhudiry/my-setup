---
name: prepare-release
description: Use when deciding whether a change is ready to release, recording its after-merge steps, or checking which pending ones are due.
---

## Workflow

1. Inspect the diff, affected behavior and data, and the project's deployment setup. Distinguish actions already covered by deployment from additional
   release actions. Use $mobile-app-infra for app-store releases.
2. Run $verification for the changed parts and determine whether the release is ready, not ready, or ready with stated limitations.
3. Identify blockers, extra release steps, rollback limits, effects on users and stored data, and necessary follow-up.
4. Record every release action a deploy does not perform in the [release ledger](#release-ledger), on the same branch as the change, so merging the
   code merges its reminder.
5. When the release creates temporary code or setup, record its cleanup with $tech-debt, including a trigger, owner when known, and evidence that
   removal is safe. For requested post-release automation, define when it runs, when it stops, what it reports, and what it does.
6. Lead with the verdict and include only populated sections: blockers, release actions, product effects, checks, automation, rollback, and cleanup.

## Release ledger

`RELEASE.md` at the repository root lists every pending action a deploy does not perform. Create it when first needed. Give each change one section:

```markdown
## <Change>

<What the change does to production, and what goes wrong if the steps are skipped.>

- [ ] <Action>, <when it can run: after deploy, once iOS 1.5.2 is on sale, after 2026-10-15>. <Command, or a link to where it is documented.>

Complete when <a check anyone can run>. Roll back by <steps>, or <why it cannot be rolled back>.
```

- Name each item's trigger so it can be checked later. An item that waits on an outside event names that event.
- Mark a finished item `[x]` with its date and result. Delete the section once it is complete; git history keeps the record.

## Checking pending actions

When asked for pending release work, and before any release or deploy, read `RELEASE.md`. Check each open item's trigger against its real source,
such as store status, the live API, analytics, or the deploy log. Report each item as due now, waiting on a named event, or done. Mark done items and
delete completed sections.
