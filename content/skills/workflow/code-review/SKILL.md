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

Each area has a focus level that sets how deep to look. For **Low** focus, report only critical findings.

In **auto-fix** areas, apply clear fixes directly and report only findings that need a decision. Report every finding instead when the user asked
for a read-only review.

- **Standards** (high focus): Check correctness and handling of reasonable edge cases.
- **Requirements** (high focus): Check that behavior matches the agreed requirements.
- **Completeness** (high focus): Identify unfinished work, unusable tests, and shortcuts that make incomplete work appear finished.
- **Performance** (high focus): Identify unnecessary work, excessive resource use, and slowdowns caused by the changes.
- **Security** (low focus): Check for exposed data and unauthorized access or actions.
- **Backward compatibility** (high focus): Check that existing clients, integrations, and stored data still work.
- **Complexity** (very high focus, auto-fix): Identify unnecessary complexity in the changed code, including a major simplification or full rewrite
  that preserves functionality. Apply fixes with $simplify.
- **Implementation** (very high focus): Assess whether the chosen approach best fits the requirements and project; recommend a better one when the
  benefits justify it.
- **API and database design** (very high focus): Check endpoint contracts, payload shapes, schema changes, constraints, indexes, and migrations.
  Report designs that lose data integrity, force later rewrites, or make queries slow.
- **Cleanliness** (mid focus, mostly auto-fix): Check oversized files, duplication, dead code, stale comments, formatting, magic values, naming, and
  imports.
- **Framework rules** (high focus, auto-fix): Check violations of $laravel and $react where they apply.
- **Copy** (mid focus, mostly auto-fix): Check user-facing copy against $translation.

Weigh each edge case against the complexity its handling adds. If the complexity costs more than the edge case is worth, drop the finding. Never
expand the scope of the reviewed work.

Judge the change on its merits, not on how close it is to shipping; a major change or full rewrite is a valid finding.

## HTML report

When there are findings, deliver a minimal page built with $html-artifacts; otherwise reply normally.

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
