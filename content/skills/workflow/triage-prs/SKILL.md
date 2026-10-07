---
name: triage-prs
description: Use to triage a repository's open pull requests or babysit them, ranking them by merge effort and keeping each one mergeable until it merges.
---

## Triage

1. Run `bun scripts/triage-prs.ts <repo-path>` (`--help` for options). It ranks open PRs by application-code lines and migrations. It also lists
   stacks, stacked PRs behind their parent, CI state, conflicts with the default branch, and overlaps between PRs, then proposes a parent-first
   merge order. Use `--json` for the conflicting paths.
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

1. In merge order, parents first, fix each PR's mechanical blockers on its branch, in its own worktree:
   - **Behind the default branch or conflicting with it:** merge the default branch in; never rebase a shared branch.
   - **Behind its parent:** merge the parent branch in.
   - **Parent squash-merged:** rebase the child onto the default branch with `git rebase --onto` and push with `--force-with-lease`.
   - **Failing CI:** fix lint, type, and test failures caused by the default branch moving or by the merge itself.
   - **Drafts:** fix conflicts only; CI skips drafts, and a draft stays a draft.
2. Run the project's local checks before every push.
3. Stop on a PR and report it when the fix needs a logic decision, changes behavior, or answers review feedback; hand it to $help-me-land-this-pr
   if the user wants it landed. Skip any PR branch another agent session is working on, and report it.
4. Watch every open PR with the harness's pull request watcher, or rerun this section on a schedule where there is none. When a PR merges, CI
   fails, or a branch starts conflicting, repeat from step 1.
5. Stop when every PR is mergeable, merged, closed, or waiting on the user, and report the table from triage with what changed.
