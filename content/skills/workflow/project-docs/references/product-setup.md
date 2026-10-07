# Product setup

`docs/product-setup.md` is the project's only setup document. Read it before product analysis, and rewrite a section when a lasting fact
changes. Keep history only when it explains a recurring risk, product constraint, or future check.

## Content

- Product definition: what the product does, who it serves, its business model, and lasting constraints.
- User journeys and system structure: essential flows and how the relevant parts connect.
- Evidence and access: authoritative sources, safe read-only commands, access status, and exact setup steps for gaps.
- Risks and checks: recurring risks and reproducible read-only checks, including useful baselines and cost limits.

Check facts against the authoritative product and technical sources. Keep commands and API calls reproducible and production access read-only.
Exclude secrets and private connection values; treat writes, destructive queries, schema changes, long exports, and ambiguous targets as
blockers.
