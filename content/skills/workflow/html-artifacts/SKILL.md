---
name: html-artifacts
description: Use when creating an HTML file for the user to view, such as a report, review, audit, design options, or a visual comparison.
---

## Build

- Put the page in a fresh folder under the macOS temporary directory, named `<project>-<topic>.XXXX`, with `index.html` as the entry and other pages
  linked from it. `share-html` publishes every file in the folder except dotfiles, so keep briefs, logs, scripts, and raw captures in a separate
  working folder.
- Make the page work from `file://` and from HTTPS without a server. Use relative paths only. Copy the project fonts and images it needs into the
  folder. Embed data as inline JSON instead of fetching local files. Never link to `localhost`, `127.0.0.1`, `.test` hosts, or `file://` paths.
- Compress screenshots to WebP or JPEG at their display width. `share-html` rejects artifacts over 20 MB.
- Make it readable on a phone: a responsive layout down to 360 px, light and dark themes through `prefers-color-scheme`, and `lang` plus `dir="rtl"`
  for Arabic content.
- Start with a one-line header: project, title, date, and scope. Give each item a stable ID and anchor so feedback can point to it.
- When the user will respond to individual items, add a checkbox and notes field per item and a **Copy selected** control that copies Markdown. Keep
  that state in local storage keyed to the artifact.

## Design

- Show only the page's subject. Drop sections, summaries, and decoration that do not serve it.
- Keep text minimal: labels and short phrases instead of sentences. Put detail behind expandable elements.
- Keep the layout lean and dense so the main content fits one screen: tight spacing, side-by-side panels, and collapsed detail instead of scrolling.
- For a project page, use the project's theme and design system: its tokens, fonts, colors, and component styles.
- For interactive pages, especially long forms, follow $ux-ui and minimize effort: one-click choices over typing, the recommended answer
  preselected, notes fields opened on demand, visible progress, keyboard navigation, and a sticky bar with the selected count and main action.

## Deliver

- Open the page at desktop and phone widths. Fix missing assets, broken layout, and console errors.
- Run `share-html <folder>`, or `share-html <file>` for a single self-contained file. Add `--name <words>` for a readable URL. The URL is private
  behind Cloudflare Access, and the upload is deleted after 30 days.
- Give the user the printed URL and the local path.
- When `share-html` reports that wrangler is not signed in, repair access with $service-access. When it reports that the host is not behind
  Cloudflare Access, stop and report it; never publish another way.
- A page that needs a running dev server cannot be shared this way; give its local URL.
