---
name: html-artifacts
description: Use whenever creating HTML for the user.
---

Pick the home by what the page is, even when the host offers its own HTML preview or render tools, unless a skill such as $align asks for
an in-thread render:

- **hq page** for one-off reports, analyses, and option pages: write JSON blocks and run `hq push page <file.json>`; hq draws them with its
  own components at `/p/<slug>` on hq, behind the owner's sign-in, and the page never expires. See
  [hq-pages.md](references/hq-pages.md) for the blocks.
- **share-html** for demos, screenshot galleries, and fully custom pages that blocks cannot draw.
- **In the thread** for PR status cards: render them with `html_render` from [pr-cards.html](assets/pr-cards.html), one `<article>` per
  PR, keeping its styles; check with `html_preview` first.

Recurring reports are never pages: push their data with `hq push report`, per keeper-core (owner, 2026-11-12).

## Design

Make each page a joy to read that respects the reader's limited attention. Lead with visuals, choosing the best one for each point,
without overdoing it; plain text is fine where it says the thing best. These hold for both homes:

- The owner scans and never reads a wall of text. The first screen answers the question: a `verdict` with at most three one-line
  findings, then the one visual that proves them. After that, each section is a visual with a caption of one or two lines. Keep the
  visible page under about 300 words. Methods, caveats, and raw tables go in a `details` block or are left out.
- A plain question with text options goes to the caller's question inbox per ASK-ONCE, never onto a page; pages carry choices that need
  visuals or sit beside the analysis that explains them.
- Before sharing, open the page at phone and laptop widths and exercise its interactive states.

On hq, layout, dark theme, project colors and logos, and the fixed pick bar come with the blocks. A visual no block draws, such as a
mockup or diagram, goes in an `html` block or an option's `html`, which renders in a sandboxed frame.

A share-html page has full freedom of layout, style, and interaction, within these: always a dark theme; on a laptop, a native desktop
layout across the window, such as multi-column grids and side-by-side panels, that collapses to one column on a phone, never a
phone-width column centered on a wide screen; self-contained, with inline CSS and scripts, relative or inline assets, and no
`localhost`, `.test`, or `file://` links; and `dir="rtl"` for Arabic.

## Choices

Put choices in an `options` block on an hq page, pushed from a T3 thread. `hq push page` gives each block a letter from the shared
sequence and prints its keys. Page choices never go to hq's Needs you; only keepers post there, with `hk ask`. The owner picks across
every block on the page, and one Send reaches this thread as one message with the keys joined, such as `F1 G2 H3`. Ask the same choices
in chat per ASK-ONCE with the printed keys. Re-push the same slug to revise a page; blocks keep their letters by `id`, and a sent block
stays picked.

## share-html

- `share-html <folder>` publishes every non-dot file in the folder, up to 20 MB. For a living page, add `--name <words> --stable` to keep
  one URL. Links expire 30 days after publishing.
- Read a published page, such as to review your own demo, with `share-html get <url> [--out <dir>]`; it saves the page and its assets.
  Plain fetches and browsers without the owner's sign-in only reach the Cloudflare sign-in page.
- Repair missing Cloudflare sign-in with $service-access. If the host is not behind Cloudflare Access, stop; never publish another way.
