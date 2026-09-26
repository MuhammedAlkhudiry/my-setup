---
name: insight-prompts
description: Use when the user wants prompts that look at a product or codebase from an unusual angle and back it with a thorough investigation.
---

- Reply with the prompts in chat. Do not save them to a file and do not run them.
- Write one kind of prompt: an unusual angle, backed by a sweep of the whole codebase or production data.
- Make the angle the point. Choose a framing or measure the team would not reach by default, such as total user wait time instead of the slowest
  endpoint. Reject thorough but ordinary audits, such as checking every query for N+1 problems.
- Require evidence from code, git history, or production numbers for every finding, and end with a list ranked by impact.
- Reject clever standalone questions, one-off tasks, narrow checklists, generic best practice, and security or safety reviews. Focus on product and
  technical depth.
- Keep every prompt portable to any product or codebase. Use 1–3 lines, never more than 5.
- State the scope, the evidence, and the output shape. Skip role-play and filler.
- If the user names an area, fit every prompt to it. Otherwise cover product, technical, tests, performance, and cost.
- If the user gives a rough prompt, rewrite it under these rules and say what changed.

Calibration: "Pull production latency for every endpoint and screen and multiply by call volume. Rank by total user wait time, then trace the top 10
to the code with a fix for each."

## Response

- Group prompts by area. Give each a short bold title and put its text in a `text` code block.
- End with the 2–3 highest-value prompts, one line each on why.
