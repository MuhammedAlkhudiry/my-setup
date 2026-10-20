# Report

## Delivery

Deliver the review in the reply; never save it to a file. With findings, show a minimal $html-artifacts page inline above the reply when the
host can render one; otherwise reply in Markdown. State scope and verification limits in every report.

- Group by review area, then severity. Mark checked areas without findings `Clear`; distinguish unreviewed and inapplicable areas.
- Use the fields below, badging action separately from severity. Explain with comparisons, diffs, evidence, or diagrams as needed;
  label proposed code as a suggestion.
- Add labeled notes and a **Should fix** checkbox per finding, checked only for **Fix**. Selection means inclusion, not resolution.
  Provide **Select all**, **Clear selection**, **Copy selected**, and a selected count; disable copying with no selection.
- Copy selected findings and entered notes as Markdown below; offer selectable text if clipboard access fails. Preserve notes/selections when collapsing
  sections; show storage failures without blocking use.

## Copied finding format

```md
- **<ID> — <Fix | Decide> · <Blocker | Major | Minor | Nit>: <one-line summary>** (`<file>:<line>`)
  - **Breaks:** what goes wrong, and for whom.
  - **Fix:** the change; for **Decide**, the options and your pick.
  - **Notes:** the user's notes, when present.
```

Action:

- **Fix:** clearly wrong, with one correct fix preserving agreed behavior and scope.
- **Decide:** competing fixes, behavior/scope changes, or preferences needing the user's call.

Severity:

- **Blocker:** must not ship: incorrect, unsafe, or loses data.
- **Major:** works today but will cause failures, rework, or bad user experience.
- **Minor:** worth fixing now at contained cost.
- **Nit:** optional preference; state once.
