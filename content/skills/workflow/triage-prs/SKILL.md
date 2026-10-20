---
name: triage-prs
description: Use to triage open pull requests or keep them mergeable.
---

## Triage

1. Run `bun <skill-dir>/scripts/triage-prs.ts <repo-path> --json`; `<skill-dir>` is the installed $triage-prs directory.
   Use its size, stack, CI, conflict, and overlap assessments to build a parent-first merge order; `--verbose` prints the proposed order.
2. Check what the script cannot judge:
   - Unresolved review feedback/questions, owner decisions, and requests to keep, pause, or close PRs.
   - Unusual release steps, released-client compatibility, migrations, blast radius, security, privacy, and QA needs.
   - Description, demo, and checklist readiness; obsolete PRs; registry-line overlaps versus logic clashes.
3. Adjust tiers and merge order with these findings; explain why.
4. Report a **PR status** block per PR, user decisions first, then merge order. Start its `👉` bullet with the tier, then give
   blockers and the next action (merge, review, fix, decision).

## Babysit

After triage, run only when asked to babysit PRs or keep them mergeable. Never merge; the user merges.

1. Parents first, check owner holds, review feedback, drafts, and checkout ownership. In a clean PR worktree, run
   `bun <skill-dir>/scripts/pr-refresh.ts <pr-url> --repo <checkout> --expected-head <full-pr-head-sha> --json`;
   See `--help` for prerequisites, receipts, and exits; `--dry-run` is read-only.
   - **Behind its base or parent:** let the script merge the actual base, check, push normally, and sign off.
   - **Conflicting:** resolve and commit mechanical conflicts, then rerun with the original expected head. Inspect exit 4 before restarting:
     the remote head/base or local checkout changed.
   - **Parent squash-merged:** rebase the child onto the default branch with `git rebase --onto` and push with `--force-with-lease`.
   - **Failing CI:** fix mechanical lint, type, and test failures.
   - **Drafts:** mark ready only when requested and checks pass.
2. Handle squash-restacking and CI fixes yourself: local checks before every push, pushed-head sign-off afterward. The script never
   force-pushes or answers feedback.
3. Stop for logic decisions, behavior changes, or review feedback; use $code-review and $prs for an authorized follow-up. Coordinate only
   conflicting work in the same checkout or shared resources.
4. Watch open PRs with the harness watcher, or rerun on a schedule when unavailable. Repeat from step 1 after a merge, CI failure, or conflict.
5. Stop when every PR is mergeable, merged, closed, or waiting on the user; resend the PR status blocks that changed.
