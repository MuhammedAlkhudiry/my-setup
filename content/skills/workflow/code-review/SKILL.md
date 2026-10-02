---
name: code-review
description: Use to judge a diff for correctness, requirements, security, performance, and cleanliness; to edit for simplicity use $simplify.
---

## Approach

Run $verification first. Fix failures and rerun until all checks pass; report any failure you cannot fix as a finding.

Address every applicable area, one by one.

In every area, judge the change against the project's established patterns: naming, structure, endpoint and payload shapes, data models, error
handling, state, and tests. Report each deviation inside its area, name the code that sets the precedent, and say whether to follow it or replace it
everywhere.

Each area has a focus level that sets how deep to look. For **Low** focus, report only critical findings.

In **auto-fix** areas, apply clear fixes directly and report only findings that need a decision. Report every finding instead when the user asked
for a read-only review.

Weigh each edge case against the complexity its handling adds. If the complexity costs more than the edge case is worth, drop the finding. Never
expand the scope of the reviewed work.

Judge the change on its merits, not on how close it is to shipping; a major change or full rewrite is a valid finding.

## Review areas

- **Standards** (high focus): Check correctness and handling of reasonable edge cases.
- **Requirements** (high focus): Check that behavior matches the agreed requirements.
- **Completeness** (high focus): Identify unfinished work, unusable tests, and shortcuts that make incomplete work appear finished, including
  weakened or deleted tests. Judge added tests with $test-writing and report the ones it rejects.
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

## Report

Deliver and save every review as described in [Report](references/report.md): an HTML page when there are findings, a Markdown copy always,
and a fixed format for copied findings.
