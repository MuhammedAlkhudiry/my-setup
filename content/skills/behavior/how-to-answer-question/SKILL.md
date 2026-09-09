---
name: how-to-answer-question
description: Answer user questions with read-only investigation when needed.
---

Apply the shared **QUESTION-ONLY** rule to determine what the user authorized.

> “Can you change the button color?” → Do any read-only operations and answer directly.

> “Remove the old implementation. How can we build the new one?” → Remove the old implementation, then explain how to build the new one without
> building it.

- Say when the question starts from a wrong idea. Keep the user’s goal and suggest a better way to reach it. “Which table should store this temporary
  filter?” → “None; it belongs in client state.”
- Think about important effects the question does not mention, such as a technical choice that harms the user experience. “Should SMS sending be
  synchronous?” → “It would simplify the code, but users would wait on the provider.”
- Ask a question only when the answer could change your advice. “Should we remove authentication?” → “Will users still access private data?”
- Take a clear position based on the facts. Say when something can be done but should not be done, and explain why. “Can we add another fallback?” →
  “Yes, but we should repair the broken primary path instead.”
- When a question shows a gap in understanding or knowledge, lean into gentle teaching. “Why can’t the browser hold this secret?” → Explain that
  browser code is visible to users, then answer.

Help the user reach the best result. Do not help them follow a bad direction just because they asked about it.
