---
name: html-artifacts
description: Use whenever you create any HTML page or file for the user, such as a report, review, audit, design options, a visual comparison, or a visual prototype.
---

Every HTML page for the user goes through this skill and ends as a published `share-html` URL. Never hand over a local file or local URL.

The page is disposable. Spend minutes, not polish: one `index.html` with inline CSS and JS, no build step, no framework. A visual prototype may
add a shared stylesheet and font files next to `index.html`.

## Build

- Create a fresh folder under the macOS temporary directory named `<project>-<topic>.XXXX`. `share-html` publishes every non-dot file in it, so keep
  scripts, logs, and raw captures elsewhere.
- Keep it self-contained: relative paths, inline data, and copies of any images it needs. Never link to `localhost`, `.test` hosts, or `file://`
  paths. Capture content from a running app as screenshots or inline data.
- Save screenshots as WebP or JPEG at display width. `share-html` rejects artifacts over 20 MB.
- Add a viewport meta tag and a fluid layout so it reads on a phone. Use `dir="rtl"` for Arabic content.
- When the user will respond to individual items, give each a stable ID, a checkbox, and a notes field, plus a **Copy selected** button that copies
  Markdown.

## Design

Pick one mode:

- **Feature proposal** when the page proposes a feature, explains a product idea, or asks for a product decision. Follow
  [references/feature-proposal.md](references/feature-proposal.md); the minimal-page rules below do not apply.
- **Visual prototype** when the user asks to visualize something or asks for a prototype or mockup.
- **Minimal page** for everything else, such as reports, reviews, audits, and comparisons.

### Minimal page

Minimal is the rule, not a preference. Every element must earn its place; when unsure, cut it.

- Show only the page's subject. No intro, summary, recap, legend, footer, or decoration.
- No sentences on the surface. Use labels, numbers, and short phrases. Put any detail behind `<details>`.
- Fit the main content on one screen: tight spacing, side-by-side panels, and collapsed detail instead of scrolling.
- For design options in a project, reuse its colors and fonts. Otherwise use plain system styling.

### Visual prototype

Show each item as it would look, not as text about it.

- Render every item as a realistic mockup of the real product screen, in a phone frame, a browser frame, or both, to match the platforms it
  affects. Use the project's design system, fonts, real copy, and text direction.
- Mark what is new with one to three short callouts on the mockup. Put the item's title and one-line detail beside it.
- For more than a few items, first write a shared CSS kit and a script that screenshots one mockup. Give each subagent a range of items, one
  fragment file per item, then assemble one page.
- Check every mockup screenshot for clipping, overlap, and wrong text direction before publishing.

## Publish

- Open the page once and fix anything visibly broken.
- Run `share-html <folder>`. Add `--name <words>` for a readable URL. The URL is private behind Cloudflare Access and expires after 30 days.
- Give the user the printed URL only.
- When `share-html` reports that `cf` is not signed in, repair access with $service-access. When it reports that the host is not behind
  Cloudflare Access, stop and report it; never publish another way.
