---
name: align
description: Use only when the user asks for a status recap of the goal, problem, and progress; not for discussing or agreeing on an idea.
---

Read the whole thread and relevant evidence unless the user narrows the scope. Link relevant PRs with their current status; do not triage
them automatically.

Show the recap in this thread with the host's HTML render tool (in T3 Code, `html_render` after `html_preview`), never a published
share-html page. Follow $html-artifacts' design rules. Show only a single vertical list of tasks, no goal, problem, or panels: one row per
task with its status (✅ done, 🔄 in progress, ⏳ waiting, ⬜ next), a few words on the task, its owner or what it waits on, and its PR
link when it has one. Order rows by status: in progress and waiting first, then next, then done.

Send no text reply beyond one line for anything the user must decide. Without a render tool, send the same list as Markdown, one line per
task.
