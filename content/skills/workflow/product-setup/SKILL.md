---
name: product-setup
description: PRODUCT_SETUP.md creation and maintenance.
---

## Workflow

1. Read existing setup before product analysis.
2. Create it when setup maintenance is requested. Refresh it only when lasting setup information has changed.
3. Check the authoritative product and technical sources.
4. Keep `PRODUCT_SETUP.md` as the sole setup document. Retain history only when it explains a recurring risk, product constraint, or future check.
5. Keep commands and API calls reproducible and production access read-only. Exclude secrets and private connection values; treat writes, destructive
   queries, schema changes, long exports, and ambiguous targets as blockers.

## Content

- Product definition: what the product does, who it serves, its business model, and lasting constraints.
- User journeys and system structure: essential flows and how the relevant parts connect.
- Evidence and access: authoritative sources, safe read-only commands, access status, and exact setup steps for gaps.
- Risks and checks: recurring risks and reproducible read-only checks, including useful baselines and cost limits.
