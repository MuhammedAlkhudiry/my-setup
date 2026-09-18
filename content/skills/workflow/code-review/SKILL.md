---
name: code-review
description: Use to judge a diff for correctness, requirements, security, performance, and cleanliness; to edit for simplicity use $simplify.
---

## Review areas

Address every applicable area, one by one.

- **Standards:** Check correctness and handling of reasonable edge cases.
- **Requirements:** Check that behavior matches the agreed requirements.
- **Completeness:** Identify unfinished work, unusable tests, and shortcuts that make incomplete work appear finished.
- **Performance:** Identify unnecessary work, excessive resource use, and slowdowns caused by the changes.
- **Security:** Check for exposed data and unauthorized access or actions.
- **Backward compatibility:** Check whether existing clients, integrations, and stored data still work with the changes.
- **Complexity:** Identify unnecessary complexity in the changed code. Report a major simplification or a full rewrite when it preserves functionality
  and produces a simpler result.
- **Implementation:** Assess whether the chosen approach is the best fit for the requirements and project. Recommend a better approach when the
  benefits justify the change.
- **Cleanliness:** Check oversized files, duplication, dead code, stale comments, formatting, magic values, naming, and imports.
- **Framework rules:** Check violations of $laravel and $react where they apply.
- **Copy:** Check user-facing copy against $translation.

Review the change on its merits rather than on how close it is to shipping. A finding that the work needs a major change or a complete rewrite is a
valid result.

## Finding format

Report every finding in this shape, grouped under its review area. When an area has nothing to report, say `Clear`.

```md
- **<Blocker | Major | Minor | Nit>: <one-line summary>** (`<file>:<line>`)
  - **Breaks:** what goes wrong, and for whom.
  - **Fix:** the suggested change, or the decision needed when no single fix is obvious.
```

- **Blocker:** must not ship; it is incorrect, unsafe, or loses data.
- **Major:** works today but will cause failures, rework, or a bad user experience.
- **Minor:** worth fixing now, with contained cost.
- **Nit:** optional preference; state it once and move on.
