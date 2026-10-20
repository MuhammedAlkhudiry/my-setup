---
name: html-artifacts
description: Use whenever creating HTML for the user.
---

Use the host's preview and render tools for small pages. Publish a separate page only for shareable links, durable feedback, multiple
files, or hosts without previews.

## Rules

- Phone first: fluid layout, a viewport meta tag, readable text without zooming, and tap targets at least 36px. Use `dir="rtl"` for Arabic.
- Avoid scrolling: fit the subject on one phone screen when possible, put detail behind `<details>`, and never pad content into
  oversized cards or full-width buttons.
- Show only the subject: no intro, recap, legend, or footer.
- Keep it self-contained: inline CSS and scripts, relative or inline assets, and no `localhost`, `.test`, or `file://` links. Save
  screenshots as WebP or JPEG at display width.
- Use a dark theme only, and never ship unstyled browser defaults.
- Inspect the result on a phone-width screenshot and exercise any interactive state before handing it over.

## Publish

- `share-html <folder>` publishes every non-dot file in the folder, up to 20 MB. For a living page, add `--name <words> --stable` to keep
  one URL. Links expire 30 days after publishing.
- For answers, add `--writable`, include [feedback.js](assets/feedback.js) as its header describes, and read them with
  `share-html feedback --json`.
- Repair missing Cloudflare sign-in with $service-access. If the host is not behind Cloudflare Access, stop; never publish another way.
