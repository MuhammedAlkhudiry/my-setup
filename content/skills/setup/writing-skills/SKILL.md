---
name: writing-skills
description: Write and maintain agent skills and instructions.
---

## Content

- Assume the agent is capable. Keep only reusable guidance the agent cannot get from broader instructions or authoritative sources.
- Point to the authoritative source instead of copying information the agent can look up.
- Remove obvious advice, repeated or outdated rules, unnecessary examples, and steps that achieve nothing.
- For CLI skills, require the narrowest relevant live help before acting. Keep only task-specific guidance that help does not provide.
- Include reference material only when the agent cannot reasonably retrieve it during the task or needs a fixed interpretation.
- State the rule directly and remove redundant warnings.
- Keep exact commands only when live help cannot explain how to use them for the task. Keep structures and templates only when they prevent guessing.
- Say how to check that a step is complete when this would otherwise be unclear.

## Structure

- Use only `name` and `description` YAML frontmatter. The lowercase hyphenated name must match its folder.
- Use the description to say when the skill applies. Lead with the subject or action.
- Put guidance needed every time in the skill itself. Keep separate references for guidance needed only in some tasks.
- Reference another skill as `$skill-name`.
- Keep each rule, its exceptions, and its completion check together. Remove empty sections, unclear references, and unnecessary files.

## Instruction files

Apply the same content rules to always-loaded instruction files. Edit the authoritative source, never a generated copy. Move task-specific workflows
into a skill, script, checklist, or project document and keep always-loaded instructions for lasting rules that apply broadly. Replace outdated or
overlapping rules instead of adding exceptions.
