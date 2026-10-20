---
name: prs
description: Use when preparing, describing, or marking a pull request ready for review.
---

<!-- profile:work -->

Follow WORK-GITLAB and WORK-APPROVAL. Creating a PR/MR requires user approval; editing files and fixing checklist findings do not.
Codex review approval does not authorize creation.

<!-- /profile -->

## Checklist

1. **Simplify:** run $simplify on the diff, then apply $laravel for PHP, $react for React, $verification for tests,
   $translation for user-facing text, and $ux-ui for UI changes.
2. **Docs:** fix docs made wrong by the change and record its decisions and follow-ups through $project-docs.
3. **Codex approval:** get a {{models.codex.review.displayName}} (`{{models.codex.review.id}}`) review alongside Docs for medium/large PRs
   ($triage-prs: app-code lines + 300 per migration ≥ 300), or risky changes involving auth, payments, privacy, deleted data, or a Needs you decision.
   Prefer a Codex subagent; fall back to the Codex CLI through $ai-agents-cli only when delegation is unavailable.
   Name the base branch and request high reasoning effort, blockers (bugs, security, data loss, flakes, false greens, broken contracts),
   follow-ups, or `APPROVED`. Fix blockers and rerun local checks. Request one medium-effort final recheck: confirm the fixes resolve
   blockers and add none; return `APPROVED` or remaining blockers, without new follow-ups. No third round, even after later pushes;
   bring remaining blockers to the user. Fix small follow-ups; batch the rest into a later PR or $project-docs.

When open PRs add the same new file, commit it identically in each and say so in each description, so either merge order works.

Report checklist and review results in one line; give the reason if review was skipped.

<!-- profile:personal -->

## Merging without asking

Merge a PR yourself, without the owner's go, when it changes no app or server behavior: docs, agent instructions, tests and test fixes, CI,
and tooling or scripts. It must have green sign-off on its head, be mergeable, have no unresolved feedback, and need no owner decision, such
as a new or changed product decision, roadmap, or release step. Ask first for everything else, including refactors of production code.
Report each such merge with its post-merge result.

<!-- /profile -->

## After a GitHub merge

Before other work, run the [post-merge steps](references/post-merge.md) that apply: CI on the exact merge commit, then the deploy,
migrations, jobs, and Sentry for changes that reach them. Never revert automatically.

<!-- profile:personal -->

For queued CI during a confirmed Ubicloud incident, read [runner outage recovery](references/ci-runners.md) before switching or dispatching.

<!-- /profile -->

## Sections

Start **What changes for users** with a concrete example: who notices, before/after behavior, and why it matters. Use glossary terms;
omit internal file, class, and function names. Scale detail to the change, with short paragraphs or a list of distinct behaviors.
Describe only what users can notice; leave the mechanism to the diff.

When users notice nothing, as in refactors, tooling, tests, and developer or agent docs, write
[**What changes for maintainers**](references/maintainer-section.md) instead. When a change has both, write both, users first.

<!-- profile:work -->

Include only these two sections, in order:

1. **What changes for users**, or for maintainers.
2. **Demo:** link an edited demo showing the change; see [demo media](references/demo-media.md). State plainly when a demo is unavailable.

Keep checklist results, review details, risks, and approval questions in the reply, outside the PR description.

<!-- /profile -->
<!-- profile:personal -->

Write these sections in order; omit any with nothing to say:

1. **What changes for users**, or for maintainers.
2. **Needs you / risks:** at most three one-line bullets for reviewer action: link release steps recorded through $project-docs in
   `docs/release/`; show costly-to-reverse decisions as checkboxes with the fact that makes reversal expensive; name real risks to watch.
3. **Demo:** required for UI changes; link an edited demo, following [demo media](references/demo-media.md).
4. **Performance:** only for performance work. Give before and after numbers from the same method and data, with trade-offs.
5. **Checklist.**

<!-- /profile -->

**Title:** the best-fit handoff label, unbolded, then what the user, or for maintainer-only changes the maintainer, notices:
`[✨ FEAT] Rate finished sessions`, `[♻️ REFACTOR] Screens no longer refresh requests themselves`.

Use `✨ What changes for users`, `🔧 What changes for maintainers`, and `🎬 Demo` as headings. For other sections, use
🙋 Needs you / risks, ⚡ Performance, and ✅ Checklist.
