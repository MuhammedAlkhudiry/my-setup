---
name: writing-prs
description: Use when writing or rewriting a pull request description.
---

Write the description only. Do not push, create, or edit the pull request; deliver the Markdown in the reply and save it to a temporary file.

## Sections

Write them in this order. Omit a section that has nothing to say.

1. **Needs you**
   - **After merge:** every step a deploy does not perform, such as commands, asset uploads, environment variables, provider settings, and store
     submissions.
   - **Hard to change:** a checkbox per decision that is costly to reverse once merged or released: schema and migrations, API contracts used by
     released clients, stored enum values, permissions, queue and event payloads, URLs, environment variables, native modules, and provider
     choices. Give each the one fact needed to approve it.
2. **What changes for users:** one short paragraph from the product side: who notices, and what they can now do or no longer hit. No file, class,
   or function names.
3. **Demo:** required when the UI changes. Record a video of the flow; use a screenshot only for a static state. Show before and after for a UI fix,
   and cover every changed surface: web and mobile, light and dark, RTL.
4. **Review size:** a table of changed lines by kind (app code, tests, migrations, generated and lock files, docs, assets), then the app files in
   review order with their line counts. Count with `git diff --numstat <base>...HEAD`.
5. **Performance:** only when the pull request targets performance. Before and after numbers from the same method and data, and every trade-off,
   such as memory, staleness, or complexity.
6. **QA steps:** numbered steps with the exact route, account, and data to use.
7. **Known gaps:** what was deliberately left out.
8. **Independent review:** the reviewer's verdict and what it checked.

## Media upload

Use the browser tool chosen by $browser-simulator-routing to record. To get a GitHub-hosted URL, drop the file into a comment editor on the
repository and copy the generated `user-attachments` link; do not submit the comment.

## Independent review

After the draft is complete, get a fresh review from the other agent through $ai-agents-cli: Codex when Claude implemented the work, Claude when
Codex did. Run it read-only with no inherited context.

- Give it the base, the branch, and the draft. It applies $code-review and checks every claim in the draft against the diff.
- Fix its findings, update the draft, and rerun once. Report remaining findings to the user instead of looping.
