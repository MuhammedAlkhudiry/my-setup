---
name: implementation-walkthrough
description: Gentle walkthroughs of implemented work.
---

## Durable State

1. Resolve the canonical repo root and current branch or PR identity.
2. Under `${XDG_STATE_HOME:-~/.local/state}/implementation-walkthroughs/`, derive a deterministic safe filename from the repo root and PR number,
   falling back to the branch name.
3. Before analysis or writes, resume that file or create it automatically.
4. Reconcile changes in place and mark only affected parts stale; change never justifies new state.

Persist this shape, omitting `pr` when no PR exists, and reconstruct broader context from the repository on resume:

```json
{
  "branch": "branch-name",
  "pr": 123,
  "summary": "One short description.",
  "cursor": { "part": 0 },
  "parts": [
    {
      "title": "Part title",
      "status": "pending"
    }
  ],
  "environment": { "url": "https://example.test", "note": "Durable resume context." }
}
```

## Prepare Quietly

1. Reconstruct purpose, flows, impact, risks, dependencies, and non-scope from state, branch or PR context, diffs, commits, changed files, migrations,
   config, docs, tests, and notes.
2. Split work into coherent behaviors or implementation slices.
3. Environment work is preparation, never a part. Verify a responding target URL in Chrome for web, or the built and launched target screen on a
   device for mobile. Keep preparation invisible unless it needs the user's attention.

## Walkthrough Loop

1. Use warm, calm, gentle language and the final-answer shape below for walkthrough turns.
2. Make every **Do** self-contained: include the exact target URL as a clickable Markdown link plus any required account or role, test data, starting
   state, and navigation the URL cannot encode. Never tell the user to open or visit a named page without linking directly to it.
3. Present only the current part. Treat "done" or equivalent confirmation as completion and immediately present the next part in the same turn. After
   the final part, report walkthrough completion.
4. After each walkthrough turn, persist the cursor and each part's `pending`, `completed`, `skipped`, or `stale` status.
5. When the user requests a change, pause the walkthrough and handle the work normally, regardless of size. After the fix, treat "done" or equivalent
   acceptance as completion of the current part and resume with the next part immediately. An explicit request for the next part also resumes the
   walkthrough. Reconcile affected parts before resuming.

## Final-answer shape

Keep each part focused on product behavior, substantive changes, or core implementation.

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
