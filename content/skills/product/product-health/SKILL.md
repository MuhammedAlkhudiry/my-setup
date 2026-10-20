---
name: product-health
description: Use to check live product health or investigate operational anomalies.
---

## Evaluation

- Establish scope and comparison window from `docs/product-setup.md`, project docs, recent git history, and health sources. Report missing/stale
  setup context as an observability gap.
- Compare the current window with the previous window and usual baseline. Commits are investigation leads, not proof.
- Assess relevant journeys, jobs, data integrity, performance, observability, AI usage, cost, and capacity.
- Prefer structured CLI or API output over dashboards.
- Investigate material signals until cause, impact, baseline change, and confidence are supported, or name missing evidence.

## Source routing

Identify sources and access routes from `docs/product-setup.md`.

- **Sentry:** Use $sentry-cli.
- **PostHog:** Use $cli-tools for access, $querying-posthog-data before writing HogQL, and $investigate-metric for material metric changes.
- **Queues, schedulers, servers:** Follow setup docs; use $cli-tools for Laravel Forge or SSH as applicable. Measure live backlog, job age, retries,
  failures, execution, service health, and capacity.
- **Caches, databases, managed services, full-text search:** Use $service-access or SSH. For DigitalOcean managed databases, use `doctl` and relevant
  live help before acting.

## Sentry cleanup

Resolve issues only with evidence they are fixed, inactive, superseded, or known noise. Record each with a green status emoji and why resolution was safe.

## Report contract

- Lead with findings ranked by affected users and impact on critical flows, then tabulate statistics.
- Prefix each statistics row with exactly one RATINGS marker.
- If actions exist, make ranked **Action items** the final substantive section.
