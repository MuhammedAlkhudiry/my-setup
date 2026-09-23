---
name: interview
description: Use when the user asks for an interview or when linked decisions need a series of questions; to challenge one idea use $workshop.
---

## Workflow

1. Resume a saved `progress` interview with the same objective when one exists. Inspect available evidence first, so you ask only what it cannot
   answer.
2. Use `Brief` by default. Ask the user to choose a depth only when it would materially change the interview:
   - `Brief`: cover only the most important unknowns.
   - `Standard`: cover every important decision and constraint.
   - `Exhaustive`: map the topics thoroughly, explore edge cases, and question assumptions that could affect the outcome.
3. Track the objective, unknowns, and each topic's `resolved`, `open`, `assumed`, or `deferred` state internally. Show this list only when it helps
   the user answer or when summarizing the interview.
4. Ask up to three questions together when they are independent and none requires an earlier answer. Ask dependent questions one at a time. For
   decisions, offer a few short, distinct options with their main trade-offs and identify the recommendation in plain language. When an example would
   help the user answer, give it in the surrounding reply before the question tool; keep examples out of the tool's questions and options.
5. Follow up on answers that could change the outcome at the chosen depth. Use evidence to question important assumptions and explain why they matter.
   Leave harmless unknowns alone.
6. Finish when every important topic required by the chosen depth is resolved, assumed, or deferred. Summarize the decisions, assumptions, open
   issues, and next step the original task needs. Save the summary with $saved-work as type `interview` and status `done`, recording the depth; do
   not turn it into a spec or plan. Then resume the original task.
7. If the user stops, save the partial topic list with $saved-work as type `interview` and status `progress`, then return it.
