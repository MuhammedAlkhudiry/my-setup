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
2. **Docs:** fix docs the change made wrong; record decisions and follow-ups through $project-docs.
3. **Adversarial review, big or risky PRs only:** over about 400 changed lines or 15 files (minus generated and lock files), or
   touching persisted data, auth, payments, AI prompts, deploys, or security. A fresh Claude subagent, never Codex or the author, runs
   $code-review on the diff, told the goal and to break it; Codex authors leave it to the Housekeeper, which routes it to Ops. Fix confirmed findings; recheck
   with a fresh subagent only after security, data loss, wrong persisted data, or a broken user flow.
4. **UI review gate, PRs that change what users see:** the screenshot matrix and a fresh Claude reviewer's pass per $ux-ui's UI review
   gate, linked from the 🎬 Demo; no pass, not ready.

<!-- profile:work -->

Use the PR watcher for CI completion; without it, make one bounded wait and one CI read, then hand off any still-running checks.

<!-- /profile -->

When open PRs add the same new file, commit it identically in each and say so; any order works.

Report checklist results in a line.

<!-- profile:personal -->

## Merge policy

[The merge policy](references/merge-policy.md) says who may enqueue a PR. Read it before every enqueue or approval ask.

<!-- /profile -->

## After a GitHub merge

<!-- profile:work -->

Before other work, run the [post-merge steps](references/post-merge.md) that apply to the exact merge commit. Never revert automatically.

<!-- /profile -->
<!-- profile:personal -->

The Housekeeper's Ops keeper runs the [post-merge steps](references/post-merge.md) for each batch; the owning thread checks only what
its PR changed. Never revert automatically.

<!-- /profile -->

## Title and description

Use the template below only in the owner's personal projects. Elsewhere, follow the repository's template and its recent merged PRs'
style, or else the ticket link and a few plain sentences. Keep checklist results, review details, and approval questions in the reply.

<!-- profile:personal -->

### Template

Start **What changes for users** with a concrete example: who notices, before/after behavior, and why it matters. Use glossary terms,
no file, class, or function names, only what users notice; scale detail to the change.

When users notice nothing (refactors, tooling, tests, docs), write
[**What changes for maintainers**](references/maintainer-section.md) instead; for both, write both, users first.

Write these sections in order, omitting empty ones:

1. **What changes for users**, or for maintainers.
2. **Needs you / risks:** first `⚠️ Merge risk: <level>, <main reason>` (PR status levels), then at most three one-line bullets:
   release steps in `docs/release/` via $project-docs; costly-to-reverse decisions as checkboxes with why; real risks to watch.
3. **Demo:** link an edited demo, following [demo media](references/demo-media.md); a UI PR needs one, and text is not a demo.
4. **Performance:** only for performance work: before/after numbers from one method and dataset, with trade-offs.
5. **Checklist.**

**Title:** the best-fit change label, unbolded, then what users notice, or maintainers for maintainer-only changes:
`[✨ FEAT] Rate finished sessions`, `[♻️ REFACTOR] Screens no longer refresh requests themselves`.

Headings: ✨ What changes for users, 🔧 What changes for maintainers, 🎬 Demo, 🙋 Needs you / risks, ⚡ Performance, ✅ Checklist.

<!-- /profile -->
