---
name: align
description: Use when the user asks to align or recap, often in the middle of a long thread, to restate their goal and problem in your own words and summarize where the work stands.
---

- Cover the whole thread by default, from its first message, not just the latest exchange. Narrow the scope only when the user asks for it.
- Read the conversation and relevant evidence first, such as linked PRs, saved work, and the working tree, so the response reflects what the user said
  and what actually happened.
- Check the current state of each PR the thread opened or worked on, such as merged, draft, CI failing, conflicting, or waiting on review. When four or
  more are still open, or any of them form a stack, run $triage-prs on their repository and keep only the thread's PRs.
- Derive the goal from the thread as a whole. When the goal shifted along the way, state the current goal and note what changed.
- Restate in your own words, not the user's:
  - **Goal**: the outcome the user wants and why it matters to them.
  - **Problem**: what is wrong or missing today that blocks that outcome.
- Keep the problem separate from any solution. If the user proposed one, name it apart and say whether it fits the problem.
- List the assumptions you made to fill gaps, and the points you are least sure about.
- When work has already happened, recap it against the goal:
  - Group the work by outcome, not by chronology or by tool call. Mark each group as done, in progress, or next.
  - Under each group, list the concrete results in a few words each, with their PR or reference. Note regressions and their fixes on the same line.
  - Say who owns in-progress work, such as another agent or a pending review, and what it waits on.
  - List the next steps in order, and mark paused or deferred items as such.
  - Include only what moves the goal. Leave out dead ends unless they changed the plan.

## Response

- Open with short bullets under `Goal`, `Problem`, and, when needed, `Proposed solution` and `Assumptions`.
- When there is work to recap, follow with one tree rooted at the goal, with a status emoji on each group (`✅` done, `🔄` in progress, `⬜` next)
  and PR references right-aligned on their lines, each followed by the PR's current state in words:

  ```text
  Goal: <outcome in one line>
  │
  ├─ ✅ <group> (live)
  │   ├─ <result> ................ #12 merged
  │   └─ <result> ................ #13 merged → regression fixed in #15
  │
  ├─ 🔄 <group> (<owner>, <state>)
  │   └─ <result> ................ #16 CI failing
  │
  └─ ⬜ Next
      ├─ <step>
      └─ (paused) <step>
  ```

- When $triage-prs ran, follow the tree with its table, limited to the thread's PRs.

- Keep each line to one idea. Prefer concrete wording over abstract summaries.
