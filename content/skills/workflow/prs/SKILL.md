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
3. **Adversarial review, big or risky PRs only:** over about 400 changed lines or 15 files, excluding generated code and lock files, or
   touching migrations or persisted data, authentication or permissions, payments or purchases, AI prompts, deploys, or security. Run one
   fresh Claude subagent, never Codex or the author, with $code-review on the diff, briefed with the goal and told to break it. Fix confirmed
   findings. Recheck with another fresh subagent only after a serious finding: security, data loss, wrong persisted data, or a broken user
   flow. Skip this step for every other PR.

<!-- profile:work -->

Use the PR watcher for CI completion; without it, make one bounded wait and one CI read, then hand off any still-running checks.

<!-- /profile -->

When open PRs add the same new file, commit it identically in each and say so in each description, so either merge order works.

Report checklist results in one line.

<!-- profile:personal -->

## Merging without asking

Enqueue a PR yourself, without the owner's go, when it changes no app or server behavior: docs, agent instructions, tests and test fixes,
and tooling or scripts. It must have green sign-off on its head, be mergeable, have no unresolved feedback, and need no owner decision, such
as a new or changed product decision, roadmap, or release step. Ask first for everything else, including refactors of production code.
Run `merge-queue add <owner/repo> <pr> --thread <t3ThreadId>`, then end the task. The Housekeeper owns failure relay and post-merge checks.
A successful enqueue is the handoff; do not merge directly or wait for the worker. The worker verifies each batch with local sign-off,
merges it, and deploys main with the project's `mise run deploy`. When a sibling lands first, the worker merges main into the PR branch
itself; it fails the PR, naming the conflicting files, only when that merge still conflicts.

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

Use the template below only in the owner's own personal projects. In work repositories and other people's repositories, follow that
repository's own template and the title and description style of its recent merged PRs; when it has neither, keep the description to the
ticket link and a few plain sentences. Either way, keep checklist results, review details, risks, and approval questions in the reply,
outside the PR description.

<!-- profile:personal -->

### Template

Start **What changes for users** with a concrete example: who notices, before/after behavior, and why it matters. Use glossary terms;
omit internal file, class, and function names. Scale detail to the change, with short paragraphs or a list of distinct behaviors.
Describe only what users can notice; leave the mechanism to the diff.

When users notice nothing, as in refactors, tooling, tests, and developer or agent docs, write
[**What changes for maintainers**](references/maintainer-section.md) instead. When a change has both, write both, users first.

Write these sections in order; omit any with nothing to say:

1. **What changes for users**, or for maintainers.
2. **Needs you / risks:** at most three one-line bullets for reviewer action: link release steps recorded through $project-docs in
   `docs/release/`; show costly-to-reverse decisions as checkboxes with the fact that makes reversal expensive; name real risks to watch.
3. **Demo:** required for UI changes; link an edited demo, following [demo media](references/demo-media.md).
4. **Performance:** only for performance work. Give before and after numbers from the same method and data, with trade-offs.
5. **Checklist.**

**Title:** the best-fit handoff label, unbolded, then what the user, or for maintainer-only changes the maintainer, notices:
`[✨ FEAT] Rate finished sessions`, `[♻️ REFACTOR] Screens no longer refresh requests themselves`.

Use `✨ What changes for users`, `🔧 What changes for maintainers`, and `🎬 Demo` as headings. For other sections, use
🙋 Needs you / risks, ⚡ Performance, and ✅ Checklist.

<!-- /profile -->
