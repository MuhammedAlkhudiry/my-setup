---
name: prs
description: Use when preparing, describing, or marking a pull request ready for review.
---

<!-- profile:work -->

Follow WORK-GITLAB and WORK-APPROVAL. User approval is required to create a PR/MR, not to edit files or fix checklist findings. Codex review
approval does not authorize PR/MR creation.

<!-- /profile -->

## Checklist

1. **Simplify:** run $simplify on the diff, then check applicable skills: $laravel for PHP, $react for React, $verification for tests,
   $translation for user-facing text, and $ux-ui for UI changes.
2. **Docs:** fix docs made wrong by the change and record its decisions and follow-ups through $project-docs.
3. **Codex approval:** for medium or large PRs ($triage-prs tiers: 300 or more app-code lines, a migration counting 300) or risky changes
   involving auth, payments, privacy, deleted data, or a decision under Needs you, get a {{models.codex.review.displayName}} (`{{models.codex.review.id}}`) review while doing Docs. Prefer a Codex
   subagent; use the Codex CLI through $ai-agents-cli only when Codex delegation is unavailable. Request high reasoning effort for the
   first review. Name the base branch and ask for blocking findings (bugs, security, data loss, flakes, false greens, broken contracts),
   follow-ups, or `APPROVED`. Fix blockers, rerun local checks, and obtain one medium-effort recheck. Tell it this is the final round:
   confirm each blocker is fixed and the fixes add none, then answer `APPROVED` or the blockers left, with no new follow-ups. A PR gets no
   third round, even after later pushes; bring the user anything that still blocks. Fix small follow-ups; batch the rest into a later PR or
   $project-docs.

Report results in one line, such as `✅ Simplified, framework checks, docs · {{models.codex.review.shortName}} approved` or `· {{models.codex.review.shortName}} skipped: small, low risk`.

## After a GitHub merge

Run `bun <skill-dir>/scripts/postmerge-check.ts <pr-url|merge-sha> --repo <owner/repo|checkout> --workflow <name> --timeout 600 --json`.
Use the installed $prs directory for `<skill-dir>`; the script runs from any working directory. It selects the exact merge commit's push
workflow run and reports its attempt, conclusion, failed stages, and links. Exit 75 means pending or not discovered yet; resume the check
before proceeding. Exit 1 requires inspecting and fixing or deliberately reverting the failure; the script never reverts. Use `--help` for
the full interface. This bounded CLI wait is the fallback when the harness cannot watch a merged-commit workflow.

<!-- profile:personal -->

For queued CI during a confirmed Ubicloud incident, use `ci-runner github`; restore with `ci-runner ubicloud` only after its status page marks it resolved.
Read [runner outage recovery](references/ci-runners.md) before switching or dispatching.

<!-- /profile -->

## Sections

Start with **What changes for users**. Explain who notices, what changes before and after, and why it matters, using the product's glossary
terms. Keep internal file, class, and function names out. Open with one concrete example a user would recognize.

Give each idea room: use short paragraphs separated by blank lines, or a short list when there are distinct changes. Do not compress several
behaviors into one dense paragraph. Scale the detail to the change.

<!-- profile:work -->

Include only these two sections, in order:

1. **What changes for users:** the behavior and value described above.
2. **Demo:** link an edited demo showing the change; see [demo media](references/demo-media.md). State plainly when a demo is unavailable.

Keep checklist results, review details, risks, and approval questions in the reply, outside the PR description.

<!-- /profile -->
<!-- profile:personal -->

Write these sections in order; omit any with nothing to say:

1. **What changes for users:** the behavior and value described above.
2. **Needs you / risks:** at most three one-line bullets for reviewer action: link release steps recorded through $project-docs in
   `docs/release/`; show costly-to-reverse decisions as checkboxes with the fact that makes reversal expensive; name real risks to watch.
3. **Demo:** required for UI changes; link an edited demo, following [demo media](references/demo-media.md).
4. **Performance:** only for performance work. Give before and after numbers from the same method and data, with trade-offs.
5. **Checklist:** the results above.

<!-- /profile -->

**Title:** the best-fit handoff label, unbolded, then what the user notices: `[✨ FEAT] Rate finished sessions`.

Use `✨ What changes for users` and `🎬 Demo` as headings. For other sections, use 🙋 Needs you / risks, ⚡ Performance, and ✅ Checklist.
