---
name: prepare-release
description: Release preparation, production readiness, and post-release follow-up.
---

## Workflow

1. Inspect the diff, affected behavior and data, and the project's deployment setup. Distinguish actions already covered by deployment from additional
   release actions.
2. Run $verification for the changed parts and determine whether the release is ready, not ready, or ready with stated limitations.
3. Identify blockers, extra release steps, rollback limits, effects on users and stored data, and necessary follow-up.
4. When the release creates temporary code or setup, schedule its cleanup with a trigger, owner when known, and evidence that removal is safe. For
   requested post-release automation, define when it runs, when it stops, what it reports, and what it does.
5. Lead with the verdict and include only populated sections: blockers, release actions, product effects, checks, automation, rollback, and cleanup.
