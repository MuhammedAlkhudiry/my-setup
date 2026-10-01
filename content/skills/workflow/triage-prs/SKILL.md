---
name: triage-prs
description: Use to triage a repository's open pull requests, ranking them by merge effort and readiness with stacks, CI, conflicts, and a merge order.
---

## Workflow

1. Run `bun scripts/triage-prs.ts <repo-path>` (`--help` for options). It ranks open PRs by application-code lines and migrations. It also lists
   stacks, CI state, conflicts with the default branch, and overlaps between PRs, then proposes a parent-first merge order. Use `--json` for the
   conflicting paths.
2. Check what the script cannot see, for each PR:
   - **Review state:** requested changes, unresolved threads, and unanswered questions.
   - **Decisions:** product or owner decisions the PR waits on, and PRs the owner asked to keep, pause, or close.
   - **Release:** steps outside a normal deploy, such as data backfills, reindexes, store builds, or backward compatibility with released clients.
   - **Risk:** blast radius, data migrations, security or privacy exposure, and how much QA the change needs.
   - **Readiness:** the description, demo or media, and checklist the project expects.
   - **Staleness:** PRs the default branch or another PR made obsolete, and stacked children that lag their parent.
   - **Overlaps:** whether files that conflict between PRs are shared registry lines or real logic clashes.
3. Adjust the script's tiers and merge order with these findings, and say why.
4. Report one table in merge order. Give each PR its tier, CI, blockers, and the action it needs: merge, review, a fix, or a decision. Put PRs that
   need the user's decision first.
