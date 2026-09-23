---
name: prepare-release
description: Use when deciding whether a change is ready to release, and planning its release actions, rollback limits, and post-release cleanup.
---

## Workflow

1. Inspect the diff, affected behavior and data, and the project's deployment setup. Distinguish actions already covered by deployment from additional
   release actions. Use $mobile-app-infra for app-store releases.
2. Run $verification for the changed parts and determine whether the release is ready, not ready, or ready with stated limitations.
3. Identify blockers, extra release steps, rollback limits, effects on users and stored data, and necessary follow-up.
4. When the release creates temporary code or setup, record its cleanup with $tech-debt, including a trigger, owner when known, and evidence that
   removal is safe. For requested post-release automation, define when it runs, when it stops, what it reports, and what it does.
5. Lead with the verdict and include only populated sections: blockers, release actions, product effects, checks, automation, rollback, and cleanup.
