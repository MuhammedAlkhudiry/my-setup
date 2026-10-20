---
name: interview
description: Use when the user requests an interview or linked decisions need a series of questions.
---

Use $workshop to challenge one idea.

## Workflow

1. Resume any saved `progress` interview with the same objective. Inspect available evidence before asking what it cannot answer.
2. Use `Brief` by default. Ask the user to choose a depth only when it would materially change the interview:
   - `Brief`: cover only the most important unknowns.
   - `Standard`: cover every important decision and constraint.
   - `Exhaustive`: also explore edge cases and assumptions that could change the outcome.
3. Track the objective, unknowns, and each topic's `resolved`, `open`, `assumed`, or `deferred` state internally. Show it only to help the user
   answer or summarize the interview.
4. Ask in the reply text, never with a question tool, because some hosts collapse the text around it. Ask up to three independent questions
   together; ask dependent questions one at a time. Number each question and letter its options so the user can answer like "1A 2C". For
   decisions, offer short, distinct options with trade-offs and a recommendation; give examples beside the question they help answer.
5. Follow up on answers and assumptions that could change the outcome at the chosen depth. Explain why they matter; leave harmless unknowns alone.
6. Finish when every important topic required by the chosen depth is resolved, assumed, or deferred. Summarize the decisions, assumptions, open
   issues, and next step. With $project-docs, record decisions that already rule out a change and save the summary as type `interview`, status
   `done`, with its depth. Do not turn it into a spec or plan. Resume the original task.
7. If the user stops, save the partial topic list with $project-docs as type `interview` and status `progress`, then return it.
