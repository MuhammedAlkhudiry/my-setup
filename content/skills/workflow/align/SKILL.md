---
name: align
description: Use only when the user asks for a status recap of the goal, problem, and progress; not for discussing or agreeing on an idea.
---

Read the whole thread and relevant evidence unless the user narrows the scope. Link relevant PRs with their current status; do not triage
them automatically.

Show the recap in this thread with the host's HTML render tool (in T3 Code, `html_render` after `html_preview`), never a published
share-html page. Follow $html-artifacts' design rules. Keep it small enough to take in at a glance, about one phone screen:

- **Top:** one progress bar split by status (✅ done, 🔄 in progress, ⏳ waiting, ⬜ next) with the count of each, so the overall state
  reads before any row.
- **Open work:** one compact row per open task, in progress and waiting first, then next: a status chip, at most six words on the task,
  its owner or what it waits on, and its PR link when it has one. Merge related small steps into one row; at most eight rows.
- **Folded:** done tasks and any open task beyond eight go in collapsed `<details>` sections below, closed by default, with their count in
  the summary line. Everything still appears, but nothing finished takes space up front.
- No goal, problem, explanations, or panels. Never more than one line of text per row.

Send no text reply beyond one line for anything the user must decide. Without a render tool, send the same list as Markdown: open tasks one
line each, then done tasks on one line.
