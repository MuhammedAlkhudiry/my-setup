---
name: ux-ui
description: Use before UI changes, design reviews, or visual option comparisons.
---

## Design workflow

- Inspect the goal, complete journey, platform conventions, design system, realistic content, and states.
- Follow the established system, theme, and visual character, including when adding components, tokens, or patterns for authorized work.
- Draw every piece of app UI in an HTML page with the project's mockup kit when one exists, including flow diagrams and case lists. Never use
  hand-drawn stand-ins.
- Favor distinctive minimalism: clear hierarchy, balanced spacing, restrained color, and subtle depth.
- Never add eyebrow labels (small text above headings) or invent decorative pill badges/chips. Established design-system components, including
  approved `Chip` components, take precedence over the pill restriction. Use headings and layout for hierarchy.
- Never pair pale accent fills with flat borders, icons, or text in the same color. Use a design-system tinted surface or a neutral surface;
  let one element carry the accent. Show original art for avatars, emblems, and similar subjects.
- Make the next useful action clear, such as creation in empty states or contextual editing in lists.

## Requested options

- Default to five substantially different options plus several **Wild** options beyond the brief's design constraints.
- Use a new HTML preview or visualization with $html-artifacts, unless options were requested in the app/site. Include an option switcher
  and allow multiple selections both on the page and in chat. Loop animations when useful for comparison.
- For a single selection without an implementation request, acknowledge it and ask whether to integrate. For multiple selections or selected
  parts, combine them into new options.
- Keep the page focused on options. Give each two plain sentences: what users see and why to pick it. Use short labels only for secondary detail.
  For feature proposals, summarize options in the proposal and link the full page.
- For requested revisions, create a new HTML file; preserve the previous one.

## Building a picked option

- The picked mockup is the spec. Before coding, map each element it shows to the existing component that will draw it; agree any substitute
  pattern, layout, or dropped element with the user first. Never fall back to a generic screen pattern because it is quicker.
- Before reporting, put running-app screenshots beside the picked mockup, screen by screen, fix every difference not agreed, and show the
  user that comparison.

## Design checks

After each revision, inspect the rendered result and correct:

- Inconsistent spacing, contrast, or design-system use.
- Weak hierarchy, dense content, or poorly grouped controls; separate areas without excessive nesting or boundaries.
- Missing loading/progress feedback or useful error and recovery states.
- Layout and text sizing problems using $verification; keep buttons and labels readable through wrapping or reflow.

Use purposeful icons, restrained color, and proportionate visual detail.

## Animation

Use subtle, smooth microanimations where they support interaction, following existing tokens. Avoid distracting bounce, exaggerated motion, and flashy effects.
