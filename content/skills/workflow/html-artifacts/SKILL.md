---
name: html-artifacts
description: Use whenever creating HTML for the user, including reports, options, comparisons, prototypes, and plans.
---

Prefer a self-contained HTML preview directly in the response when supported and the page is small and simple. Use the host's preview and
render tools. Use a separate artifact for large or complex HTML, several files, a shareable link, durable feedback, or an unsupported host.
Separate artifacts use one temporary `index.html` plus assets beside it, with no build step.

## Build

- Start separate artifacts with `html-artifact new <options|plan-review|blank> <topic>` from the project root. It adds the theme, `feedback.js`,
  and project's `mockup-kit/`; `--images <names>` adds kit images. Keep scripts, logs, and raw captures elsewhere.
  <!-- profile:work -->
- Without `html-artifact`, copy an [assets](assets/) template, fill its `THEME` and `KIT` markers, and check it in a browser.
  <!-- /profile -->
  <!-- profile:personal -->
- `share-html` publishes every non-dot file in that folder and rejects artifacts over 20 MB.
  <!-- /profile -->
- Keep CSS, scripts, and assets self-contained and compatible with the host. Use relative paths or inline data; never link to `localhost`,
  `.test`, or `file://`. Capture running-app content as screenshots or inline data.
- Save screenshots as WebP or JPEG at display width.
- Add a viewport meta tag and a fluid layout so it reads on a phone. Use `dir="rtl"` for Arabic content.
- For responses, prefer native feedback; otherwise use [assets/feedback.js](assets/feedback.js) following its header. Give items stable IDs
  and put choice controls in their headers, never in a separate form or dropdown. Allow multiple alternatives. Use radios only for mutually
  exclusive answers within an item; a second click clears the pick.

## Design

- Use [assets/theme.html](assets/theme.html) classes and Tailwind utilities; never ship browser defaults.
- Aim for a well-made internal tool, not a document: a header with title and chips, cards on the tinted background, one accent, and status tones
  only for ok, warn, bad.
- Draw product screens as [references/mockups.md](references/mockups.md) describes.
- Fit the main content on one screen with side-by-side panels and collapsed detail; avoid unnecessary scrolling.

Pick one mode:

- **Feature proposal:** [references/feature-proposal.md](references/feature-proposal.md); the minimal-page rules do not apply.
- **Options** when the user picks alternatives: for separate artifacts, use the template's JSON and one `options/<id>.html` per option;
  for inline previews, keep the options in one self-contained page. On revision, change only affected options.
- **Plan review** for a plan to approve: [references/plan-review.md](references/plan-review.md).
- **Visual prototype or mockup:** [references/visual-prototype.md](references/visual-prototype.md).
- **Minimal page** for everything else, such as reports, reviews, audits, and comparisons.

### Minimal page

Cut words, not styling.

- Show only the page's subject. No intro, summary, recap, legend, or footer.
- No sentences on the surface. Use labels, numbers, chips, and short phrases. Put any detail behind `<details>`.

## Hand over

- For an inline preview, use the host's preview and render tools, inspect the result, and deliver it in the response. Exercise interactive states.
- For separate artifacts, run `html-artifact check <folder>` and inspect its screenshots. Fix issues, then check once more.
  <!-- profile:personal -->
- Publish separate artifacts with `share-html <folder>`; `--name <words>` gives a readable URL. Links expire after 30 days.
- Use `--writable` for feedback pages and `share-html feedback` on "see". Hand over the printed URL.
- Repair missing Cloudflare sign-in with $service-access. If the host is not behind Cloudflare Access, stop; never publish another way.
  <!-- /profile -->
  <!-- profile:work -->
- Keep separate artifacts local and give an absolute Markdown link to `index.html`. Never upload work content to a service.
  <!-- /profile -->
