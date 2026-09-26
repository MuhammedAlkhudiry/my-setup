---
name: code-quality-report
description: Use to rate the quality of an existing codebase — architecture, complexity, consistency, dead code, types; to judge a diff use $code-review.
---

## Scope

Assess the current state of the whole codebase, not a diff. Report only; do not edit code. Route fixes to $simplify or a normal task, dependency work
to $dependency-upgrade, and lint, format, and test setup to $verification-report.

## Assessment and recommendations

Measure before judging. Run the ecosystem's analysis tools, such as knip, jscpd, and dependency-cruiser for TypeScript or PHPStan and Rector for PHP,
and use git history for churn and co-change. Install missing tools temporarily outside the repository when possible.

Rate each area from 0 to 10, with 10 representing the strongest result. Back each score with measured numbers, such as counts, percentages, or file
lists. When evidence is insufficient, report **Unmeasured** and name the missing evidence instead of assigning a score. State the reviewed scope and
excluded paths, such as generated or vendored code.

For recommendations, name tools to install, configuration changes, and code to remove. Give a roadmap to 10 for weak areas and targeted actions for
strong ones.

## Rated areas

- **Architecture and boundaries:** Map the import graph and git co-change. Report cycles, layer violations, and files in different modules that change
  together.
- **Complexity hotspots:** Rank files by churn multiplied by complexity. Report the files where both are high.
- **Consistency:** For each recurring concern, such as data fetching, errors, forms, access checks, and dates, count the distinct ways the codebase
  handles it and name the canonical one.
- **Dead code and surface area:** Report unused files, exports, dependencies, feature flags, and one-use abstractions. Confirm each has no callers.
- **Duplication:** Report the percentage of duplicated lines and the largest duplicated blocks.
- **Type safety:** Report strictness flags, explicit and implicit `any` or mixed types, and every type or lint suppression, grouped by module.
- **Naming and readability:** Report names, comments, and types that no longer match what the code does.
- **Error handling:** Report swallowed errors, silent fallbacks, and inconsistent error patterns.

## Response

End with the 10 files to fix first, ranked by churn multiplied by the problems found in them.
