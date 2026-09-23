---
name: writing-md-files
description: Use when writing or editing Markdown documents, including agent skills and always-loaded instruction files.
---

Follow the shared response guidance.

## Minimal by default

The reader has little time and skims. Every extra line costs attention and hides the lines that matter, so a long document often goes unread. A line
stays only if a reader would act wrongly or waste time without it. When nothing breaks without a line, delete it.

- Keep lasting decisions and their reasons, boundaries and limits, steps that are not obvious, and how to tell the work is done.
- Cut anything the reader can get from the code, a command's help, or a linked source.
- Cut obvious steps, background, history, and motivation that change no action.
- Cut examples that only restate a rule. Keep one example only when the rule is unclear without it.
- Cut introductions, summaries of what follows, closing recaps, hedges, and filler.
- Say each fact once. Link to it everywhere else.
- Do not add headings, sections, or template fields that the content does not fill.
- Before you add text, look for text to remove. Prefer a short document with gaps over a complete one that nobody reads; add back only what a reader
  turns out to need.

## Accuracy

- Check facts before editing. Give each fact or instruction one authoritative source, and link to it instead of copying its details elsewhere. Mark
  claims you cannot verify as unresolved.
- Look for outdated or repeated documentation while you work. Fix any you find immediately.
- Read the finished document and inspect the diff. Check for lost or invented meaning. Run any available Markdown and link checks. Report major
  structural changes, factual corrections, and unresolved gaps.

## Skills and instruction files

- Assume the agent handles routine work. Include only reusable guidance it cannot get from general rules or authoritative sources.
- Include exact commands, file layouts, or templates only when they prevent guessing.
- Make a skill's description a brief trigger: say when to use the skill, not everything it covers.
