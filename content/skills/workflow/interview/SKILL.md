---
name: interview
description: Use when the user asks for an interview or when linked decisions need a series of questions; to challenge one idea use $workshop.
---

## Workflow

1. Inspect available evidence first. Begin when requested by the user or another workflow, or when several important unknowns depend on each other and
   one question cannot resolve them.
2. Use `Brief` by default. Ask the user to choose a depth only when it would materially change the interview:
   - `Brief`: cover only the most important unknowns; use this when no depth is selected.
   - `Standard`: cover every important decision and constraint.
   - `Exhaustive`: map the topics thoroughly, explore edge cases, and question assumptions that could affect the outcome.
3. Track the objective, unknowns, and each topic's `resolved`, `open`, `assumed`, or `deferred` state internally. Show this list only when it helps
   the user answer or when summarizing the interview.
4. Ask up to three questions together when they are independent and none requires an earlier answer. Ask dependent questions one at a time. For
   decisions, offer a few short, distinct options with their main trade-offs and identify the recommendation in plain language. When an example would
   help the user answer, give it in the surrounding reply before the question tool; keep examples out of the tool's questions and options.
5. Explore answers that could change the outcome at the chosen depth. Use evidence to question important assumptions and explain why they matter.
   Leave harmless unknowns alone.
6. Finish when every important topic required by the chosen depth is resolved, assumed, or deferred. Summarize the decisions, assumptions, open
   issues, and next step the original task needs. Save the result when an interview store is available, then resume that task.
7. If the user stops, return the partial topic list immediately without saving it.

## Persistence

- In a local environment, save completed interviews under `~/interviews/<project-name>/` as `<YYYY-MM-DD>-<objective-slug>.md`.
- In a connected repository, follow an established interview-storage convention when one exists. Do not invent a repository path.
- Include `created`, `updated`, `project`, `depth`, and `description` frontmatter, followed by the confirmed summary.
- Refresh `INDEX.md` with active interviews ordered by most recently updated.
- When no writable interview store exists, return the confirmed summary in the conversation without claiming it was saved.
- Do not create a spec or plan from the interview; the workflows that use the interview handle those documents.
