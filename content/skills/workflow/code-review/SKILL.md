---
name: code-review
description: Reviewing code.
---

Review these areas:

- **Standards:** Check correctness and handling of reasonable edge cases.
- **Requirements:** Check that behavior matches the agreed requirements.
- **Completeness:** Identify unfinished work, unusable tests, and shortcuts that make incomplete work appear finished.
- **Performance:** Identify unnecessary work, excessive resource use, and slowdowns caused by the changes.
- **Security:** Check for exposed data and unauthorized access or actions.
- **Backward compatibility:** Check whether existing clients, integrations, and stored data still work with the changes.
- **Complexity:** Use $simplify to identify unnecessary complexity. Consider major simplifications or a full rewrite when they preserve functionality
  and produce a simpler result.
- **Implementation:** Assess whether the chosen approach is the best fit for the requirements and project. Recommend a better approach when the
  benefits justify the change.
- **Cleanliness** huge files, duplications, dead code, stale comments, formatting, magic values, naming, imports.
- **Laravel/React** Check violations of $laravel and $react (if applicable)
- **Copy** Check copy following $translation

In all areas, don't limit yourself as if the code about to ship and look to small fix, it's ok to say this needs major change or complete rewrite.

Response should address all mentioned areas one by one