---
name: code-quality-report
description: Use to rate an existing codebase; use $code-review for a diff.
---

## Scope

Assess the whole codebase without editing. Route fixes to $simplify or a normal task, dependencies to $dependency-upgrade, and lint/format/test
setup to $verification.

## Assessment and recommendations

Run ecosystem analysis tools, such as knip, jscpd, and dependency-cruiser for TypeScript or PHPStan and Rector for PHP. Use git history for churn
and co-change. Install missing tools temporarily outside the repository when possible.

Rate each area 0–10, strongest at 10, with measured counts, percentages, or file lists. Without evidence, report **Unmeasured** and what is missing.
State reviewed scope and excluded paths.

Recommend tools, configuration changes, and removals: a roadmap to 10 for weak areas and targeted actions for strong ones.

## Rated areas

- **Architecture and boundaries:** Map imports and git co-change; report cycles, layer violations, and cross-module files that change together.
- **Complexity hotspots:** Rank files by churn × complexity; report where both are high.
- **Consistency:** Count approaches to recurring concerns, such as data fetching, errors, forms, access checks, and dates; name the canonical one.
- **Dead code and surface area:** Confirm no callers before reporting unused files, exports, dependencies, or feature flags. Identify one-use abstractions.
- **Duplication:** Report the percentage of duplicated lines and the largest duplicated blocks.
- **Type safety:** Report strictness flags, explicit/implicit `any` or mixed types, and all type/lint suppressions by module.
- **Naming and readability:** Identify names, comments, and types that no longer match behavior.
- **Error handling:** Find swallowed errors, silent fallbacks, and inconsistent patterns.

## Response

End with the first 10 files to fix, ranked by churn × problems found.
