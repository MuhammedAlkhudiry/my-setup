---
name: service-access
description: Use for provider access, credentials, or advertising operations.
---

Read the requested provider's reference: [Apple](references/apple.md), [Google](references/google.md), [other providers](references/others.md), or
[advertising](references/ads.md).

## Access guidance

- Check existing connections, provider sign-ins, runtime access, and `$SERVICE_CREDENTIALS_HOME` before requesting credentials.
- Follow the provider's access route and verify it with the smallest read-only check.
- Pause for OAuth, 2FA, new permissions, or credentials the user must create; repair other access issues directly.
- Keep provider sign-ins in their normal locations. Store agent-managed credentials in `$SERVICE_CREDENTIALS_HOME/<provider>/`: directories 700,
  files 600.

## Advertising

Maintain the project's `docs/ads.md`, creating it if missing:

- **Scope:** purpose, destinations, apps, exclusions.
- **Accounts:** platform, manager, name, ID, currency, timezone, access, ownership.
- **Conversions:** outcomes, events, source/destination, attribution, deduplication, qualification.
- **Campaigns:** platform, IDs, name, relevance, status, objective, placement, app, budget, bids, dates, destination, observation time.
- **Lead flow:** source, consent, CRM, deduplication, response owner, qualified-lead definition.
- **Gaps:** project relationships, access, unavailable data, follow-up.
