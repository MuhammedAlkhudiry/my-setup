---
name: html-artifacts
description: Use whenever creating HTML for the user.
---

Publish every page with `share-html` and share its link, even when the host offers its own HTML preview or render tools, unless a skill
such as $align asks for an in-thread render.

PR status cards are the exception: render them in the thread with `html_render` from [pr-cards.html](assets/pr-cards.html), one `<article>`
per PR, keeping its styles; check with `html_preview` first.

## Design

Make each page a joy to read that respects the reader's limited attention. Lead with visuals, choosing the best one for each point,
without overdoing it; plain text is fine where it says the thing best. Design for the subject and reader; you have full freedom of
layout, style, and interaction. Only these hold:

- The owner scans and never reads a wall of text. The first screen answers the question: at most three one-line findings and the one
  visual that proves them. After that, each section is a visual with a caption of one or two lines. Keep the visible page under about
  300 words. Methods, caveats, and raw tables go in collapsed `<details>` sections or are left out.
- Always use a dark theme.
- It reads well on a phone and on a laptop; check screenshots at both widths, and exercise interactive states, before sharing.
- On a laptop, use a native desktop layout across the window, such as multi-column grids and side-by-side panels, that collapses to one
  column on a phone; never a phone-width column centered on a wide screen.
- When the page asks the owner to choose, let them pick on the page and send the answers (see Publish).
- Keep it self-contained: inline CSS and scripts, relative or inline assets, and no `localhost`, `.test`, or `file://` links. Use
  `dir="rtl"` for Arabic.

## Publish

- `share-html <folder>` publishes every non-dot file in the folder, up to 20 MB. For a living page, add `--name <words> --stable` to keep
  one URL. Links expire 30 days after publishing.
- For answer pages, publish with `--writable` and include [feedback.js](assets/feedback.js). Create a T3 `schedule_task`
  with `{type:"webhook"}` bound to the current thread; its prompt must read `share-html feedback --json` for this page and
  act on the answers. Wire the returned URL to the feedback button as the script header describes. Never print the webhook URL in chat;
  delete the schedule once the decisions are settled.
- When the owner says "see my choices", first read `share-html feedback --json` for that page.
- Read a published page, such as to review your own demo, with `share-html get <url> [--out <dir>]`; it saves the page and its assets.
  Plain fetches and browsers without the owner's sign-in only reach the Cloudflare sign-in page.
- Repair missing Cloudflare sign-in with $service-access. If the host is not behind Cloudflare Access, stop; never publish another way.
