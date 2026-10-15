---
name: triage-prs
description: Use to triage a repository's open pull requests or babysit them, ranking them by merge effort and keeping each one mergeable until it merges.
---

## Triage

1. Run `bun scripts/triage-prs.ts <repo-path> --json` (`--help` for options). It ranks open PRs by application-code lines and migrations. It also lists
   stacks, stacked PRs behind their parent, CI state, conflicts with the default branch, and overlaps between PRs, then proposes a parent-first
   merge order. Use `--verbose` for the detailed text report.
2. Check what the script cannot see, for each PR:
   - **Review state:** requested changes, unresolved threads, and unanswered questions.
   - **Decisions:** product or owner decisions the PR waits on, and PRs the owner asked to keep, pause, or close.
   - **Release:** steps outside a normal deploy, such as data backfills, reindexes, store builds, or backward compatibility with released clients.
   - **Risk:** blast radius, data migrations, security or privacy exposure, and how much QA the change needs.
   - **Readiness:** the description, demo or media, and checklist the project expects.
   - **Staleness:** PRs the default branch or another PR made obsolete.
   - **Overlaps:** whether files that conflict between PRs are shared registry lines or real logic clashes.
3. Adjust the script's tiers and merge order with these findings, and say why.
4. Report one table in merge order. Give each PR its tier, CI, blockers, and the action it needs: merge, review, a fix, or a decision. Put PRs that
   need the user's decision first.

## Babysit

Run when the user asks to babysit the PRs or keep them mergeable, after triage. Never merge; the user merges.

1. Parents first, check owner holds, review feedback, drafts, and checkout ownership. In a clean PR worktree, run
   `bun <skill-dir>/scripts/pr-refresh.ts <pr-url> --repo <checkout> --expected-head <full-pr-head-sha> --json`;
   `<skill-dir>` is the installed $triage-prs directory. Use `--dry-run` for reads only; `--help` lists prerequisites and exits.
   - **Behind its base or parent:** the script merges the actual base, checks, pushes normally, and signs off.
   - **Conflicting:** resolve and commit mechanical conflicts, then rerun with the original expected head. The receipt gives paths and resume
     state. Exit 4 means remote movement; inspect it before restarting.
   - **Parent squash-merged:** rebase the child onto the default branch with `git rebase --onto` and push with `--force-with-lease`.
   - **Failing CI:** fix mechanical lint, type, and test failures.
   - **Drafts:** mark ready only when requested and checks pass.
2. Keep squash-restacking and CI fixes with the agent: local checks before every push, pushed-head sign-off afterward. The script requires
   same-repository GitHub branches and local `check`/`signoff` mise tasks; it never force-pushes or answers feedback.
3. Stop for logic decisions, behavior changes, or review feedback; use $code-review and $prs for an authorized follow-up. Coordinate only
   conflicting work in the same checkout or shared resources.
4. Watch every open PR with the harness's pull request watcher, or rerun this section on a schedule where there is none. When a PR merges, CI
   fails, or a branch starts conflicting, repeat from step 1.
5. Stop when every PR is mergeable, merged, closed, or waiting on the user, and report the table from triage with what changed.
