# Report

## HTML report

When there are findings, deliver a minimal page built with $html-artifacts; otherwise reply normally.

Also save every review as Markdown in one place: `~/Documents/code-reviews/<project>/<YYYY-MM-DD>-<topic>.md`. Include the reviewed scope, the
verification limits, each area's result, and every finding in the copied finding format below, plus its evidence. Give the user the file's path
beside the page URL.

- State the reviewed scope and verification limits. Group findings by review area, order them by severity, and mark areas with no findings `Clear`.
  Distinguish unreviewed or inapplicable areas from those checked and clear.
- Give each finding the fields below. Badge its action apart from its severity.
- Explain each finding with what clarifies it: side-by-side current/proposed behavior or code, highlighted diffs, expandable evidence, or
  diagrams. Label proposed code as a suggestion.
- Give each finding a labeled notes field and a **Should fix** checkbox, checked for **Fix** only. Selection means inclusion, not resolution.
  Provide **Select all**, **Clear selection**, and **Copy selected** controls with a selected count. Disable copying when nothing is selected.
- Copy selected findings as Markdown in the format below, including entered notes. Offer selectable text if clipboard access fails. Retain notes and
  selections when collapsing sections. Show storage failures without blocking use.

## Copied finding format

```md
- **<ID> — <Fix | Decide> · <Blocker | Major | Minor | Nit>: <one-line summary>** (`<file>:<line>`)
  - **Breaks:** what goes wrong, and for whom.
  - **Fix:** the change; for **Decide**, the options and your pick.
  - **Notes:** the user's notes, when present.
```

Action:

- **Fix:** clearly wrong; one correct fix that keeps agreed behavior and scope.
- **Decide:** needs the user's call: competing fixes, a behavior or scope change, or a preference.

Severity:

- **Blocker:** must not ship; it is incorrect, unsafe, or loses data.
- **Major:** works today but will cause failures, rework, or a bad user experience.
- **Minor:** worth fixing now, with contained cost.
- **Nit:** optional preference; state it once and move on.
