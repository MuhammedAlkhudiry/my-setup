---
name: code-review
description: Use to judge a diff for correctness, requirements, security, performance, and cleanliness; to edit for simplicity use $simplify.
---

## Review areas

Run $verification first. Fix failures and rerun until all checks pass; report any failure you cannot fix as a finding.

Address every applicable area, one by one.

In every area, judge the change against the project's established patterns: naming, structure, endpoint and payload shapes, data models, error
handling, state, and tests. Report each deviation inside its area, name the code that sets the precedent, and say whether to follow it or replace it
everywhere.

- **Standards:** Check correctness and handling of reasonable edge cases.
- **Requirements:** Check that behavior matches the agreed requirements.
- **Completeness:** Identify unfinished work, unusable tests, and shortcuts that make incomplete work appear finished.
- **Performance:** Identify unnecessary work, excessive resource use, and slowdowns caused by the changes.
- **Security:** Check for exposed data and unauthorized access or actions.
- **Backward compatibility:** Check that existing clients, integrations, and stored data still work.
- **Complexity:** Identify unnecessary complexity in the changed code, including a major simplification or full rewrite that preserves functionality.
- **Implementation:** Assess whether the chosen approach best fits the requirements and project; recommend a better one when the benefits justify it.
- **API and database design:** Check endpoint contracts, payload shapes, schema changes, constraints, indexes, and migrations. Report designs that
  lose data integrity, force later rewrites, or make queries slow.
- **Cleanliness:** Check oversized files, duplication, dead code, stale comments, formatting, magic values, naming, and imports.
- **Framework rules:** Check violations of $laravel and $react where they apply.
- **Copy:** Check user-facing copy against $translation.

Judge the change on its merits, not on how close it is to shipping; a major change or full rewrite is a valid finding.

## HTML report

When there are findings, deliver a minimal standalone HTML file with embedded styles and scripts, built with $html-artifacts; otherwise reply
normally. Open a preview when available.

- State the reviewed scope and verification limits. Group findings by review area, order them by severity, and mark areas with no findings `Clear`.
  Distinguish unreviewed or inapplicable areas from those checked and clear.
- Give each finding a stable ID and the fields below.
- Explain issues and fixes through side-by-side current/proposed behavior or code, highlighted differences, expandable evidence, or diagrams. Choose
  what clarifies each finding; label proposed code as a suggestion.
- Give every finding an unchecked **Include in copied feedback** checkbox and a labeled notes field. Selection means inclusion, not resolution.
  Provide **Select all**, **Clear selection**, and **Copy selected** controls with a selected count. Disable copying when nothing is selected.
- Copy selected findings as Markdown in the format below, including entered notes. Offer selectable text if clipboard access fails. Retain notes and
  selections when collapsing sections and across reloads using local storage keyed to the review. Show storage failures without blocking use.

## Copied finding format

```md
- **<ID> — <Blocker | Major | Minor | Nit>: <one-line summary>** (`<file>:<line>`)
  - **Breaks:** what goes wrong, and for whom.
  - **Fix:** the suggested change, or the decision needed when no single fix is obvious.
  - **Notes:** the user's notes, when present.
```

- **Blocker:** must not ship; it is incorrect, unsafe, or loses data.
- **Major:** works today but will cause failures, rework, or a bad user experience.
- **Minor:** worth fixing now, with contained cost.
- **Nit:** optional preference; state it once and move on.
