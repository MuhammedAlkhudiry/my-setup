---
name: code-review
description: Review code changes against project standards and agreed requirements.
---

Review two areas separately:

- `Standards`: correctness, maintainability, and documented project conventions.
- `Spec`: whether the behavior matches the agreed requirements.

## Workflow

1. Use the comparison point named by the user. Otherwise determine the base branch or use the current staged and unstaged changes. Ask only when the
   review scope is unclear.
2. Confirm which changes are being compared and that there are changes to review. Use `git diff <fixed-point>...HEAD` for branch-style comparisons.
3. Find the agreed requirements in the user's request or supporting documents. If none exist, skip that part of the review and report
   `No spec available`.
4. Read applicable repository instructions and conventions, then review Standards and Spec independently. Documented project standards override
   general judgment; do not report issues already enforced by tooling unless the change bypasses that tooling.
5. Tie every finding to a specific file or changed lines. Report the finding count and most serious issue for each area.

## Finding format

Severity: `CRITICAL` is exploitable, destructive, or release-blocking; `HIGH` is serious; `MEDIUM` is contained; `LOW` is minor. Every finding must
name the problem, location, actual impact, and a specific fix:

```md
- **<CRITICAL | HIGH | MEDIUM | LOW>: <problem>** (`<file>:<line>`)
  - **Impact:** <impact>
  - **Fix:** <fix>
```

## Output

```md
## Standards

<findings in the required format, or "No findings">

## Spec

<findings in the required format, "No findings", or "No spec available">

Summary: Standards <count>; Spec <count>. Worst Standards issue: <item or none>. Worst Spec issue: <item or none>.
```
