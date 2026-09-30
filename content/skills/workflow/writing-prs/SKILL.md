---
name: writing-prs
description: Use when writing or rewriting a pull request description.
---

Write the description only. Do not push, create, or edit the pull request; deliver the Markdown in the reply and save it to a temporary file.

## Sections

Write them in this order. Omit a section that has nothing to say.

1. **Needs you**
   - **After merge:** a link to the change's section in `RELEASE.md`, never a copy of its steps. When the change needs a step a deploy does not
     perform, such as a command, asset upload, environment variable, provider setting, or store submission, and the branch does not record it
     there, record it with $prepare-release first.
   - **Hard to change:** a checkbox per decision that is costly to reverse once merged or released: schema and migrations, API contracts used by
     released clients, stored enum values, permissions, queue and event payloads, URLs, environment variables, native modules, and provider
     choices. Give each the one fact needed to approve it.
2. **What changes for users:** one short paragraph from the product side: who notices, and what they can now do or no longer hit. No file, class,
   or function names.
3. **Demo:** required when the UI changes. Deliver an edited demo, never a raw recording; see [Demo media](#demo-media). Use a video for a flow
   and a screenshot for a static state. Show before and after for a UI fix, and cover every changed surface: web and mobile, light and dark, RTL.
4. **Review size:** a table of changed lines by kind (app code, tests, migrations, generated and lock files, docs, assets). Split app code into
   backend, frontend, and mobile rows; in a monorepo, give each changed app or package its own row instead and name its layer. Then list the app
   files in review order with their line counts, grouped the same way. Count with `git diff --numstat <base>...HEAD`.
5. **Performance:** only when the pull request targets performance. Before and after numbers from the same method and data, and every trade-off,
   such as memory, staleness, or complexity.
6. **QA steps:** numbered steps with the exact route, account, and data to use.
7. **Known gaps:** what was deliberately left out.

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

Include media only when it shows something a reviewer needs, such as a UI change, a visual bug, or output that is hard to read as text. Upload
every media file yourself and embed it in the description by its GitHub-hosted URL. A local path, a placeholder, or a request for the user to
upload is never an acceptable result, and a local file is never a reason to stop. To get the URL, drop the file into a comment editor on the
repository with the browser and copy the generated `user-attachments` link; do not submit the comment.
