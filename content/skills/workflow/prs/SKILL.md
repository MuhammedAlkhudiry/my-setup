---
name: prs
description: Use when preparing, describing, or marking a pull request ready for review.
---

A pull request stays a draft until the [checklist](#checklist) passes. Deliver the title and description in the reply and save them to a temporary
file; do not create the pull request or edit its description. Besides checklist fixes on the branch, the only action on the pull request itself
is [marking low-review files viewed](references/viewed-files.md) once it exists.

## Checklist

1. **Simplify:** run $simplify on the branch diff, then check the diff against each skill its files call for: $laravel for PHP, $react for React,
   $test-writing for tests, $translation for user-facing text, and $ux-ui for UI changes.
2. **Docs:** fix every doc the branch made wrong, and record its decisions and follow-ups, through $project-docs.
3. **Codex approval:** only for a medium or large pull request ($triage-prs tiers: 300 or more app-code lines, a migration counting 300) or a
   risky one: auth, payments, privacy, deleted data, or a decision under Needs you. Run GPT Sol through $ai-agents-cli in the background
   during Docs: `codex exec -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -o <file> "<prompt>"`. The prompt names the base branch
   and asks for findings that should block merging, or `APPROVED` when none remain. Fix valid findings, rerun local checks, and review new
   commits at medium effort with earlier findings and your replies; answer rejected ones with a reason. After three rounds without
   approval, bring the user the open disagreements.

Report the results in one line: `✅ $simplify, $laravel, docs · Sol approved in round 2` or `· Sol skipped: small, low risk`.

## Sections

Write them in this order. Omit a section that has nothing to say.

1. **Description:** two to four sentences on what the change does and why, from the product side: who notices, and what they can now do or no
   longer hit. No file, class, or function names, and no terms that exist only in code, such as "credit", "receipt", or "outcome"; use the
   product's glossary words. Open with one concrete before-and-after a user would recognize, such as "You finish a 30-minute session on 'Read
   30 minutes'…".
2. **Needs you / risks:** at most three one-line bullets, only for what the reviewer must act on or approve:
   - A link to the change's file in `docs/release/` for steps a deploy does not perform, never a copy of them. When the branch does not record
     a needed step there, record it with $project-docs first.
   - Each decision costly to reverse once released, such as schema, API contracts, stored enum values, environment variables, or provider
     choices, as a checkbox with the one fact needed to approve it.
   - A real risk to watch after merge.
3. **Demo:** required when the UI changes. Link an edited demo page, never a raw recording; see [Demo media](references/demo-media.md).
4. **Review size:** a table of changed lines by kind (app code, tests, migrations, generated and lock files, docs, assets). Split app code into
   backend, frontend, and mobile rows; in a monorepo, give each changed app or package its own row instead and name its layer. Then list the app
   files in review order with their line counts, grouped the same way. Count with `git diff --numstat <base>...HEAD`.
5. **Performance:** only when the pull request targets performance. Before and after numbers from the same method and data, and every trade-off,
   such as memory, staleness, or complexity.
6. **Checklist:** the [checklist](#checklist) results.

**Title:** the best-fit handoff result label, unbolded, then what the user notices: `[✨ FEAT] Rate finished sessions`.

## Emojis

Start each section heading with an emoji, such as 📝 Description, 🙋 Needs you / risks, 🎬 Demo, 📏 Review size, ⚡ Performance, and ✅
Checklist. Mark items too: 🚀 after-merge steps, 🔒 decisions hard to reverse, ⚠️ risks, and 🖥️ 🌐 📱 🧪 backend, frontend, mobile, and test rows.
