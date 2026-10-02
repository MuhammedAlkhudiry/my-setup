---
name: html-artifacts
description: Use whenever you create any HTML page or file for the user, such as a report, review, audit, design options, a comparison, a prototype, or a plan to approve.
---

<!-- profile:personal -->

Every HTML page for the user goes through this skill and ends as a published `share-html` URL. Never hand over a local file or local URL.

<!-- /profile -->
<!-- profile:work -->

Every HTML page for the user goes through this skill and ends as a local file. Never upload it to any service; it may hold company data.

<!-- /profile -->

Disposable but designed: one `index.html` plus assets beside it, no build step.

## Build

<!-- profile:personal -->

- Create a fresh folder under the system temporary directory named `<project>-<topic>.XXXX`. `share-html` publishes every non-dot file in it, so keep
  scripts, logs, and raw captures elsewhere.
  <!-- /profile -->
  <!-- profile:work -->
- Create a fresh folder under the system temporary directory named `<project>-<topic>.XXXX`. Keep scripts, logs, and raw captures elsewhere.
  <!-- /profile -->
- Keep it self-contained: relative paths, inline data, and copies of any images it needs. Never link to `localhost`, `.test` hosts, or `file://`
  paths. Capture content from a running app as screenshots or inline data.
  <!-- profile:personal -->
- Save screenshots as WebP or JPEG at display width. `share-html` rejects artifacts over 20 MB.
  <!-- /profile -->
  <!-- profile:work -->
- Save screenshots as WebP or JPEG at display width.
  <!-- /profile -->
- Add a viewport meta tag and a fluid layout so it reads on a phone. Use `dir="rtl"` for Arabic content.
- When the user will respond, give items stable IDs and add [assets/feedback.js](assets/feedback.js); follow its header.

## Design

- Paste [assets/theme.html](assets/theme.html) into `<head>`. Build with its classes (`page`, `card`, `chip`, `stat`, `table`, `pair`, `shot`)
  and Tailwind utilities; never ship browser defaults.
- Aim for a well-made internal tool, not a document: a header with title and chips, cards on the tinted background, one accent, and status tones
  only for ok, warn, bad.
- For design options in a project, override `@theme` with its colors and fonts.

Pick one mode:

- **Feature proposal** when the page proposes a feature, explains a product idea, or asks for a product decision. Follow
  [references/feature-proposal.md](references/feature-proposal.md); the minimal-page rules below do not apply.
- **Plan review** for a plan to approve: [references/plan-review.md](references/plan-review.md).
- **Visual prototype** when the user asks to visualize something or asks for a prototype or mockup.
- **Minimal page** for everything else, such as reports, reviews, audits, and comparisons.

### Minimal page

Minimal content, full design. Every element must earn its place; when unsure, cut the words, not the styling.

- Show only the page's subject. No intro, summary, recap, legend, or footer.
- No sentences on the surface. Use labels, numbers, chips, and short phrases. Put any detail behind `<details>`.
- Fit the main content on one screen: dense cards, side-by-side panels, and collapsed detail instead of scrolling.

### Visual prototype

Show each item as it would look, not as text about it.

- Render every item as a realistic mockup of the real product screen, in a phone frame, a browser frame, or both, to match the platforms it
  affects. Use the project's design system, fonts, real copy, and text direction.
- Mark what is new with one to three short callouts on the mockup. Put the item's title and one-line detail beside it.
- Put each item in a `card` with ID, title, and chips in its header. Show before and after with `pair`; use `shot-empty` for a missing capture.
- For more than a few items, first write a shared CSS kit and a script that screenshots one mockup. Give each subagent a range of items, one
  fragment file per item, then assemble one page.
- Check every mockup screenshot for clipping, overlap, and wrong text direction before publishing.

<!-- profile:personal -->

## Publish

- Open the page once and fix anything visibly broken.
- Run `share-html <folder>`. Add `--name <words>` for a readable URL. The URL is private behind Cloudflare Access and expires after 30 days.
- Add `--writable` for `feedback.js` pages; on "see", run `share-html feedback`.
- Give the user the printed URL only.
- When `share-html` reports that `cf` is not signed in, repair access with $service-access. When it reports that the host is not behind
  Cloudflare Access, stop and report it; never publish another way.

<!-- /profile -->
<!-- profile:work -->

## Hand over

- Open the page once and fix anything visibly broken.
- Give the user the absolute path to `index.html` as a Markdown link. Never publish it with `share-html` or any other upload.

<!-- /profile -->
