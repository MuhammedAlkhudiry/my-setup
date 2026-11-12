---
name: align
description: Use only when the user asks for a status recap of the goal, problem, and progress; not for discussing or agreeing on an idea.
---

The owner asks for this after losing track of a thread, so the recap must be quick to take in at the top and detailed one tap down.
Read the whole thread and relevant evidence unless the user narrows the scope. Link relevant PRs with their current status; do not triage
them automatically.

Show the recap in this thread with the host's HTML render tool (in T3 Code, `html_render` after `html_preview`), never a published
share-html page. Follow $html-artifacts' design rules. The first screen, down to the open-work rows, fits one phone screen; detail lives
in collapsed `<details>` sections, closed by default:

- **Goal:** one line on what the thread is for.
- **Flow:** a small diagram of the thread's main steps from start to finish, marking where the work is now.
- **Needs you:** open owner decisions first, each with its lettered options and the recommendation, so the owner answers without
  scrolling back.
- **Progress:** one bar split by status (✅ done, 🔄 in progress, ⏳ waiting, ⬜ next) with the count of each.
- **Open work:** one row per open task, in progress and waiting first, then next: a status chip, at most six words on the task, its owner
  or what it waits on, and its PR link. Merge related small steps; at most eight rows. Each row expands to its detail: before → after,
  why it waits, the PR status card, the demo link, and the next step.
- **Decisions so far:** collapsed; each owner pick in the thread, with its letter and what it changed.
- **Done:** collapsed, with the count in the summary line; each done task expands like an open row.

Send no text reply beyond one line for anything the user must decide. Without a render tool, send the same sections as Markdown: goal,
needs you, open tasks one line each, then decisions and done tasks one line each.
