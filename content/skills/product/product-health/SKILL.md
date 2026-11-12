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
- Investigate every flagged signal until its cause is proven or likely, or every named check came back empty; "investigate" is never
  an action item, and an anomaly is never published undiagnosed (owner, 2026-11-11).
- Read the open findings the keeper carries from earlier runs first; never re-flag a finding already explained.

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

Recurring reports follow this contract (owner, 2026-11-11):

- Open with a verdict: "Nothing needs you", or at most three findings ranked by affected users and money. Each finding gives before →
  after against the usual range, its cause, what it costs users or money, and one action with an owner and a date.
- Rate a reading only when it falls outside the four-week same-weekday range; a small count needs two days or a 7-day sum before it
  rates. Unrated rows stay plain.
- Keep the same skeleton and metric order every day. List no unchecked areas; keep a caveat only when it would change the verdict.
- A quiet day gets one line on the status item and no report. When the caller keeps reports as typed data, fill its product-health
  schema instead of a page.
- Count provider refusals, such as a messaging provider's per-person cap or a recipient's opt-out, apart from the product's own errors,
  and say whether a fallback delivered; only the product's own errors rate as failures.
- Before flagging a drop in activation or sign-ups, check installs and ad spend for the same window and name either as the cause when it
  explains the drop.
- Server and capacity details go to Ops, not the report, unless they explain a finding.
