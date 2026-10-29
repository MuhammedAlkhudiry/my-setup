---
name: prs
description: Use when preparing, describing, or marking a pull request ready for review.
---

<!-- profile:work -->

Follow WORK-GITLAB and WORK-APPROVAL. Creating a PR/MR requires user approval; editing files and fixing checklist findings do not.

For ticket work, put the ticket key in the branch name, within the project's branch convention, and in the title, and link the ticket in
the description.

<!-- /profile -->

## Checklist

1. **Simplify:** run $simplify on the diff, then apply $laravel for PHP, $react for React, $verification for tests,
   $translation for user-facing text, and $ux-ui for UI changes.
2. **Docs:** fix docs made wrong by the change and record its decisions and follow-ups through $project-docs.
3. **Adversarial review, big or risky PRs only:** over about 400 changed lines or 15 files (excluding generated and lock files), or
   touching persisted data, auth or permissions, payments, AI prompts, deploys, or security. Run one fresh Claude subagent, never Codex or
   the author, with $code-review on the diff, briefed with the goal and told to break it. Fix confirmed findings; recheck with another fresh
   subagent only after a serious finding: security, data loss, wrong persisted data, or a broken user flow.

<!-- profile:work -->

Use the PR watcher for CI completion; without it, make one bounded wait and one CI read, then hand off any still-running checks.

<!-- /profile -->

When open PRs add the same new file, commit it identically in each and say so in each, so either merge order works.

Report checklist results in one line.

<!-- profile:personal -->

## Merging without asking

Enqueue a PR yourself, without the owner's go, when it changes no app or server behavior: docs, agent instructions, tests and test fixes,
and tooling or scripts. It must have green sign-off on its head, be mergeable, have no unresolved feedback, and need no owner decision, such
as a new or changed product decision, roadmap, or release step. Ask first for everything else, including refactors of production code.
Run `merge-queue add <owner/repo> <pr> --thread <t3ThreadId>` and end the task; the enqueue is the handoff; never merge directly or wait.
The worker signs off each batch locally, merges it, and deploys main; after a sibling lands, it merges main into the PR branch and fails
it, naming the conflicting files, only if that still conflicts. The Housekeeper owns failure relay and post-merge checks.

<!-- /profile -->

## After a GitHub merge

<!-- profile:work -->

Before other work, run the [post-merge steps](references/post-merge.md) that apply to the exact merge commit. Never revert automatically.

<!-- /profile -->
<!-- profile:personal -->

The Housekeeper runs the [post-merge steps](references/post-merge.md) once per repository batch on its final main SHA: the queue's
deploy, then migrations, jobs, and Sentry for changes that reach them. Never revert automatically.

<!-- /profile -->

## Title and description

Use the template below only in the owner's personal projects. Elsewhere, follow the repository's template and its recent merged PRs'
style, or else write the ticket link and a few plain sentences. Keep checklist results, review details, risks, and approval questions in the
reply, not the PR description.

<!-- profile:personal -->

### Template

Start **What changes for users** with a concrete example: who notices, before/after behavior, and why it matters. Use glossary terms,
no internal file, class, or function names, and only what users notice; scale detail to the change.

When users notice nothing, as in refactors, tooling, tests, and docs, write
[**What changes for maintainers**](references/maintainer-section.md) instead. When a change has both, write both, users first.

Write these sections in order, omitting empty ones:

1. **What changes for users**, or for maintainers.
2. **Needs you / risks:** at most three one-line bullets for reviewer action: link release steps recorded through $project-docs in
   `docs/release/`; show costly-to-reverse decisions as checkboxes with the fact that makes reversal expensive; name real risks to watch.
3. **Demo:** link an edited demo, following [demo media](references/demo-media.md); a UI PR is not ready without one, and a text
   description of a run is not a demo.
4. **Performance:** only for performance work: before and after numbers from the same method and data, with trade-offs.
5. **Checklist.**

**Title:** the best-fit handoff label, unbolded, then what users notice, or maintainers for maintainer-only changes:
`[✨ FEAT] Rate finished sessions`, `[♻️ REFACTOR] Screens no longer refresh requests themselves`.

Headings: ✨ What changes for users, 🔧 What changes for maintainers, 🎬 Demo, 🙋 Needs you / risks, ⚡ Performance, ✅ Checklist.

<!-- /profile -->
