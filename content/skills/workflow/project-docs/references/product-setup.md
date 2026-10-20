# Product setup

Use `docs/product-setup.md` as the only setup document. Read it before product analysis and update lasting facts when they change. Keep history
only to explain a recurring risk, constraint, or future check.

## Content

- Product definition: what the product does, who it serves, its business model, and lasting constraints.
- User journeys and system structure: essential flows and how the relevant parts connect.
- Evidence and access: authoritative sources, safe read-only commands, access status, and exact setup steps for gaps.
- Risks and checks: recurring risks and reproducible read-only checks, including useful baselines and cost limits.

Verify facts against authoritative sources. Keep commands reproducible and production access read-only. Exclude secrets and private connection
values; treat writes, destructive queries, schema changes, long exports, and ambiguous targets as blockers.
