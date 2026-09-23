---
name: implementation-walkthrough
description: Use when guiding the user step by step through implemented work to inspect or QA it, saving progress between turns.
---

## Saved progress

1. Find the repository and its current PR, or the branch when no PR exists.
2. Resume the $saved-work tracker `walkthrough-pr-<number>`, or `walkthrough-<branch-slug>` when no PR exists. Create it as type `tracker` when
   none exists.
3. Record the summary, target URL, resume notes, current part, and each part's `pending`, `completed`, `skipped`, or `stale` status. Reconstruct
   broader context from the repository on resume.
4. Update the same tracker when the implementation changes. Mark only affected parts stale. Set its status to `done` when the walkthrough ends.

## Prepare Quietly

1. Use saved progress and repository evidence to understand what changed, why, and what the walkthrough should cover.
2. Split the work into parts that each explain one behavior or related change; skip trivial changes.
3. Prepare the environment before the walkthrough; do not make setup a walkthrough part. Verify the target with $browser-simulator-routing: a
   responding URL for web, or the built and launched screen on a device for mobile. Keep preparation invisible unless it needs the user's attention.

## Walkthrough Loop

1. Use warm, plain language and the turn shape below.
2. Make every **Do** self-contained: include the exact target URL as a clickable Markdown link plus any required account or role, test data, starting
   state, and navigation the URL cannot encode. Never tell the user to open or visit a named page without linking directly to it.
3. Present only the current part. Treat "done" or equivalent confirmation as completion and immediately present the next part in the same turn. After
   the final part, report walkthrough completion.
4. Save the tracker after each turn.
5. When the user requests a change, pause and handle it normally, regardless of size. Update affected parts, then continue; accepting the fix
   completes the current part.

## Turn shape

```md
## Side talk

Directly handle anything that does not belong in the current part. Omit this section when unused.

## Part <number>/<total> - <title>

**How it works**

A short plain-language behavioral explanation with the technical context needed now.

**Do**

One small, exact, self-contained action for inspecting or exercising the part, including the clickable target URL and everything needed to complete
it.

**Expected**

The observable result of that action.
```
