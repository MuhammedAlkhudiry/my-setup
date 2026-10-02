---
name: writing-prs
description: Use when writing or rewriting a pull request description.
---

Write the description only. Do not push, create, or edit the pull request; deliver the Markdown in the reply and save it to a temporary file.

## Sections

Write them in this order. Omit a section that has nothing to say.

1. **Description:** two to four sentences on what the change does and why, from the product side: who notices, and what they can now do or no
   longer hit. No file, class, or function names.
2. **Needs you / risks:** at most three one-line bullets, only for what the reviewer must act on or approve:
   - A link to the change's section in `RELEASE.md` for steps a deploy does not perform, never a copy of them. When the branch does not record a
     needed step there, record it with $prepare-release first.
   - Each decision costly to reverse once released, such as schema, API contracts, stored enum values, environment variables, or provider
     choices, as a checkbox with the one fact needed to approve it.
   - A real risk to watch after merge.
3. **Demo:** required when the UI changes. Link an edited demo page, never a raw recording; see [Demo media](#demo-media). Use a video for a flow
   and a screenshot for a static state. Show before and after for a UI fix, and cover every changed surface: web and mobile, light and dark, RTL.
4. **Review size:** a table of changed lines by kind (app code, tests, migrations, generated and lock files, docs, assets). Split app code into
   backend, frontend, and mobile rows; in a monorepo, give each changed app or package its own row instead and name its layer. Then list the app
   files in review order with their line counts, grouped the same way. Count with `git diff --numstat <base>...HEAD`.
5. **Performance:** only when the pull request targets performance. Before and after numbers from the same method and data, and every trade-off,
   such as memory, staleness, or complexity.

## Emojis

Use emojis in the description as visual markers so it scans quickly: start each section heading with one, such as 📝 Description, 🙋 Needs you
/ risks, 🎬 Demo, 📏 Review size, and ⚡ Performance, and mark items inside sections, such as 🚀 for after-merge steps, 🔒 for decisions that are
hard to reverse, ⚠️ for risks, and 🖥️ 🌐 📱 🧪 for backend, frontend, mobile, and test rows.

## Demo media

Capture with the tool chosen by $browser-simulator-routing, then edit the capture into a demo that a reviewer understands without running the
branch. Choose the editing tools yourself.

- Setup never appears: the demo starts on the screen where the change begins.
- Only the change remains: page loads, typing, navigation, retries, and idle time are cut. A wait the flow needs is sped up and labeled.
- A short caption at each step names what changes on screen.
- The changed region is readable: crop or zoom when it is small on the full screen.
- Before and after appear side by side, or in sequence with a label for each.
- A video lasts under 30 seconds and stays under 10 MB. A screenshot is cropped to the changed region with the change marked.
- The final cut is checked for wrong text, stale states, and private data.

Include media only when it shows something a reviewer needs, such as a UI change, a visual bug, or output that is hard to read as text. Put
every media file on one demo page built with $html-artifacts: one labeled block per changed surface, such as web or mobile, light or dark, and
RTL, with before and after side by side and each video or screenshot under its caption. Under 🎬 Demo, write a single link to the published URL
that names what it covers. Never upload media to GitHub, and never deliver a local path, a placeholder, or a request for the user to upload.
