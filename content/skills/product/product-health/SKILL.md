---
name: product-health
description: Use to check a live product's health or investigate anomalies in errors, jobs, data, performance, or cost.
---

## Workflow

1. Establish the scope and comparison window from `PRODUCT_SETUP.md`, recent git history, project documentation, and available health sources.
2. Deliver the ranked health report.

## Evaluation

- Report missing or stale `PRODUCT_SETUP.md` context as an observability gap.
- Compare the current window with both the previous window and usual baseline. Treat recent commits as investigation leads, not proof.
- Assess only relevant product journeys, jobs, data integrity, performance, observability, AI usage, and cost or capacity.
- Prefer structured CLI or API output over dashboards.
- Investigate each material signal until its cause, impact, baseline change, and confidence are supportable or the missing evidence is explicit.

## Source routing

Use `PRODUCT_SETUP.md` to identify the relevant sources and access routes.

- **Sentry:** Use $sentry-cli.
- **PostHog:** Use $cli-tools for PostHog source access, $querying-posthog-data before writing any HogQL query, $investigate-metric for material
  metric changes, and $diagnosing-sdk-health for SDK health.
- **Queues, schedulers, and servers:** Follow `PRODUCT_SETUP.md`. Use $cli-tools for Laravel Forge or SSH as applicable. Measure live backlog, job
  age, retries, failures, execution, service health, and capacity.
- **Caches, databases, managed services, and full-text search:** Use $service-access or SSH. For DigitalOcean managed databases, use `doctl` and read
  the narrowest relevant live help before acting.

## Sentry cleanup

- Resolve an issue during the report only after evidence confirms it is fixed, inactive, superseded, or known noise.
- Record every resolved issue with a green status emoji and explain why resolution was safe.

## Report contract

- Lead with findings and analysis, then place pure statistics in a table.
- When action items exist, end with a ranked **Action items** section as the final substantive section.
- Prefix every statistics table row with exactly one interpretation marker: 🟢 for healthy or improved, 🟡 for warning or uncertainty, and 🔴 for
  failure or regression.
- Rank findings by the number of affected users and impact on critical flows.
