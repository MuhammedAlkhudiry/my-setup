# Plan review page

A plan review page puts an implementation plan in front of the owner so they can approve the costly parts, correct wrong beliefs, and edit the rest,
then hand everything back in one step. Use it when a plan has at least one decision that is hard to reverse, or more steps than a chat reply can
carry comfortably, or when the user asks for it. Keep short plans in chat.

## Build

1. For a separate artifact, run `html-artifact new plan-review <topic>` to build `index.html` from
   [../assets/plan-review.html](../assets/plan-review.html). For an inline preview, adapt its layout into one self-contained page.
2. The template's `<script id="plan">` example defines the schema; keep its field names. For a separate artifact, replace only that JSON.
3. Give the plan an `id` that names it and its version, such as `plan-notif-prefs-v1`.

## Content

The page leads with what the owner must decide. Write for someone who will not read the code.

- **`value`**: who notices, two to four problems they have today, and what they can do after. Product words only, no file or class names.
- **`approvals`**: only decisions that are costly to reverse once released, such as stored values, schema, API contracts, what existing users or
  their data get, and provider choices. `kind` names the category. `fact` is the one fact that makes reversing it expensive. Give two or three
  `options`, each with a one-line `tradeoff`, and mark your recommendation with `"rec": true`. A decision that is easy to change later is a step,
  not an approval.
- **`assumptions`**: beliefs about the code, data, or product that the plan depends on and that you did not verify, at most five. `why` says what
  breaks if it is wrong. Verify what you can before asking.
- **`visuals`**: one to three, each with a `kind`: `html` for a small mockup of what the user sees, built from theme classes; `mermaid` for a
  flow; `diff` for a $show-me style tree of what changes (`+` new, `-` removed, `~` changed).
- **`milestones`**: slices that each ship something a user can see, not layers such as backend and frontend. `value` says what that slice gives
  users. Steps are one line each with `risk` of `low`, `med`, or `high`; tests belong inside the steps, not in a final milestone.

## Hand over

Follow the parent skill's delivery choice: an inline preview for a small, self-contained plan when supported, otherwise a separate artifact.
Use native feedback when available. For other previews or local files, tell the user to press Copy and paste the summary into chat.

## Apply feedback

Read native feedback or the copied summary. For a published writable page, read "see" feedback as the parent skill describes.

Act on the summary:

- Apply each decision answer. Ask again in chat, briefly, for any decision marked NOT DECIDED.
- Check each assumption marked wrong in the code, then fix every part of the plan that relied on it.
- Apply every edit, removal, and addition; keep the IDs it names.
- Deliver the revised plan as a new version with the next version in its `id`. Keep existing IDs, give new items new IDs, mark every revised item with
  `"changed": true`, and say in chat what changed and why.
