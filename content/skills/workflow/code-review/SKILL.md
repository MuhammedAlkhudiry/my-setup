---
name: code-review
description: Use to review a diff; use $simplify to edit for simplicity.
---

## Approach

Stay within the reviewed scope. For a read-only review, report findings without editing. Otherwise, in auto-fix areas, apply clear fixes
and report only findings needing a decision.

Run $verification first. In an editable review, fix task-related failures and rerun until they pass. Report failures you cannot fix or
that fall outside scope as findings.

Address every applicable area against established naming, structure, contracts, data models, error handling, state, and tests. For each
deviation, cite the precedent and recommend following it or replacing it everywhere. Low-focus areas report only critical findings.

Drop edge-case findings whose fix costs more complexity than it is worth. Judge the change on its merits regardless of shipping proximity;
a major change or rewrite can be a valid finding.

## Review areas

- **Standards** (high): correctness and reasonable edge cases.
- **Requirements** (high): agreed behavior.
- **Completeness** (high): unfinished work, unusable/weakened/deleted tests, and shortcuts hiding incomplete work. Judge added tests with
  $verification; report rejected tests.
- **Performance** (high): unnecessary work, resource use, and slowdowns introduced by the diff.
- **Security** (low): exposed data and unauthorized access or actions.
- **Backward compatibility** (high): existing clients, integrations, and stored data.
- **Complexity** (very high, auto-fix): simplify or rewrite with $simplify while preserving functionality.
- **Proportionality** (very high): each fix sized to how often real users hit its problem. Flag fixes that slow or break a common path,
  such as a new wait, loading state, or offline failure, to cover a rare case; changes beyond the stated fix, such as a shared helper or
  animation swapped elsewhere; fixes for test-environment artifacts, such as simulator quirks or a cache shared only locally; and workarounds
  whose claimed cause the rest of the code contradicts. Recommend the lightest fix that solves the user-facing problem, or dropping it.
- **Implementation** (very high): better approaches when benefits justify changing the design.
- **API and database design** (very high): contracts, payloads, schema, constraints, indexes, and migrations; data integrity, future rewrites,
  and query cost.
- **Cleanliness** (mid, mostly auto-fix): oversized files, duplication, dead code, stale comments, formatting, magic values, naming, imports.
- **Framework rules** (high, auto-fix): applicable $laravel and $react rules.
- **Copy** (mid, mostly auto-fix): user-facing text against $translation.

## Report

Deliver reviews using [the report format](references/report.md).
