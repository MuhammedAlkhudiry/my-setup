---
name: align
description: Use only when the user asks for a status recap of the goal, problem, and progress; not for discussing or agreeing on an idea.
---

Read the whole thread and relevant evidence unless the user narrows the scope. Return only the list below, rooted at the current goal,
with applicable items in this order. Name the owner or blocker for current work. Link relevant PRs with their current status; do not
triage them automatically.

Write it as a Markdown list, never box-drawing characters or a code block: links must stay clickable and lines must wrap on a phone.
Give each point its own list item; nest a sub-list when one label has several points.

```markdown
**Goal:** <outcome>

- ⚠️ **Problem:** <what prevents it>
- ❓ **Assumption:** <unverified belief>
- ✅ **Done:**
  - <result>
  - <result>
- 🔄 **In progress:** <work, owner, or wait>
- ⬜ **Next:** <action>
```
