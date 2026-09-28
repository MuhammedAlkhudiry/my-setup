# Feature proposal page

A proposal page explains one feature idea to the owner, so they can understand it quickly and decide. It reads like a short, well-illustrated
story, not a spec sheet. The minimal-page rules do not apply: write full sentences, scroll freely, and explain.

## Reader test

Before publishing, read only the first screen as someone who has never seen the codebase. If they cannot say what the feature does, who it is for,
and why it matters, rewrite the first screen. Then read the whole page and cut anything that does not help that reader decide.

## First screen

- One plain sentence naming the problem a real person has today.
- One large mockup of the feature doing its job, in the product's real design, copy, and text direction.
- Three short lines on what changes for that person.
- Nothing else: no tables, endpoints, file names, size labels, chip rows, or section navigation above the fold.

## Order

Follow this order. Drop a section only when it has nothing to say.

1. **Why.** A short story in full sentences about one person: their situation today, the friction, and how their day looks once the feature
   exists. Use a realistic name and situation.
2. **What it looks like.** A storyboard of 3–5 steps along that person's journey. Each step is one mockup with one plain sentence under it.
   Include the moment the person gets value, and one empty, error, or edge state with its recovery.
3. **How it works.** The rules the person experiences, in plain sentences: what triggers it, what they see, what they control, and what never
   happens. Describe behavior, not implementation.
4. **Options.** When there are real alternatives, give each a small mockup and two sentences: what the person would see, and why to pick it. Mark
   the recommended option and say why in one sentence.
5. **Risks and open questions.** Each risk as a plain sentence about its effect on people, with the mitigation beside it.
6. **Decisions needed.** The questions the owner must answer, each with a stable ID, a checkbox or choice, a notes field, and a **Copy selected**
   button.
7. **For engineering.** One collapsed `<details>` block at the end: data, API, permissions, compatibility, rollout, analytics, effort, and code
   references.

## Language

- Explain each product term the first time it appears, in the sentence itself or in a short inline note.
- Keep internal shorthand out of the main flow: no size codes, table names, service names, or compressed phrases joined with `·`. Put those in
  the engineering block.
- Prefer concrete examples over abstractions: "Sara opens the tree and sees 6 new relatives since 12 September" over "change surfacing".
- Keep a calm, kind tone. Show the person being helped, not the system being clever.

## Layout

- One reading column about 70 characters wide for prose, 16–17 px body text, and generous line height. Mockups may break wider than the column.
- Plenty of whitespace, one accent color, and the project's fonts and colors. Avoid walls of cards, chips, badges, and dense tables.
- Section headings are plain questions or statements a reader would ask or expect, such as "Why this matters" or "What Sara sees".
- Aim for a page that reads in about three minutes before the engineering block. Split a larger feature into several proposals rather than
  growing one page.
