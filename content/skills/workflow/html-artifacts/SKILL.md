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

- Start with `html-artifact new <options|plan-review|blank> <topic>` from the project root: a temp folder with theme, `feedback.js`, and the
  project's `mockup-kit/`; `--images <names>` adds kit images. Keep scripts, logs, and raw captures elsewhere.
  <!-- profile:work -->
- Without `html-artifact`, copy an [assets](assets/) template, fill its `THEME` and `KIT` markers, and check it in a browser.
  <!-- /profile -->
  <!-- profile:personal -->
- `share-html` publishes every non-dot file in that folder and rejects artifacts over 20 MB.
  <!-- /profile -->
- Keep it self-contained: relative paths, inline data, and copies of any images it needs. Never link to `localhost`, `.test` hosts, or `file://`
  paths. Capture content from a running app as screenshots or inline data.
- Save screenshots as WebP or JPEG at display width.
- Add a viewport meta tag and a fluid layout so it reads on a phone. Use `dir="rtl"` for Arabic content.
- When the user will respond, give items stable IDs, add [assets/feedback.js](assets/feedback.js) and follow its header. Put each choice
  control in the item's header, as a checkbox or pill, so the user picks while looking at the item. Never gather choices into a separate
  form or use dropdowns. Let the user pick several alternatives; use a radio group only for answers within one item that exclude each
  other, such as approve or reject. A second click clears any pick; `feedback.js` does this for radios.

## Design

- Build with the classes of [assets/theme.html](assets/theme.html) (`page`, `card`, `chip`, `stat`, `table`, `pair`, `shot`)
  and Tailwind utilities; never ship browser defaults.
- Aim for a well-made internal tool, not a document: a header with title and chips, cards on the tinted background, one accent, and status tones
  only for ok, warn, bad.
- Draw product screens as [references/mockups.md](references/mockups.md) describes.
- Avoid making the user scroll, vertically or sideways. Fit the main content on one screen with dense cards, side-by-side panels, and
  collapsed detail.

Pick one mode:

- **Feature proposal** when the page proposes a feature, explains a product idea, or asks for a product decision. Follow
  [references/feature-proposal.md](references/feature-proposal.md); the minimal-page rules below do not apply.
- **Options** when the user picks one or more alternatives: write only the template's JSON and one `options/<id>.html` per option; on
  revision, rewrite only changed fragments.
- **Plan review** for a plan to approve: [references/plan-review.md](references/plan-review.md).
- **Visual prototype** when the user asks to visualize something or asks for a prototype or mockup:
  [references/visual-prototype.md](references/visual-prototype.md).
- **Minimal page** for everything else, such as reports, reviews, audits, and comparisons.

### Minimal page

Minimal content, full design. Every element must earn its place; when unsure, cut the words, not the styling.

- Show only the page's subject. No intro, summary, recap, legend, or footer.
- No sentences on the surface. Use labels, numbers, chips, and short phrases. Put any detail behind `<details>`.

## Hand over

- Run `html-artifact check <folder>` and view its screenshots. Fix what it reports or what looks broken, run it once more, then stop.
  <!-- profile:personal -->
- Run `share-html <folder>`. Add `--name <words>` for a readable URL. The URL is private behind Cloudflare Access and expires after 30 days.
- Add `--writable` for `feedback.js` pages; on "see", run `share-html feedback`.
- Give the user the printed URL only.
- When `share-html` reports that `cf` is not signed in, repair access with $service-access. When it reports that the host is not behind
  Cloudflare Access, stop and report it; never publish another way.
  <!-- /profile -->
  <!-- profile:work -->
- Give the user the absolute path to `index.html` as a Markdown link. Never publish it with `share-html` or any other upload.
  <!-- /profile -->
