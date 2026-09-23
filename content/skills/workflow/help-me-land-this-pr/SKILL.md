---
name: help-me-land-this-pr
description: Use when an open PR needs explaining, reviewing, QA, and follow-up until it is ready to merge.
---

## Workflow

1. Brief the user: the PR's purpose, technical decisions, and trade-offs, marking which reasons are recorded and which are inferred; then review
   feedback, checks, merge status, and each blocker with what it needs.
2. Run $code-review. Fix findings that need no user decision, then rerun the project's checks.
3. Guide QA with $implementation-walkthrough.
4. Until the PR is mergeable or needs an external action, address review comments, failing checks, and merge conflicts on the PR branch. Stop for a
   hard blocker or a user decision.
5. Do not merge; the user merges.
