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
- **Tracking:** per platform, what is tagged (UTM, click IDs, pixel and server events), blind spots, and measured coverage with its date.
- **Gaps:** project relationships, access, unavailable data, follow-up.

Never give a channel a stop, scale, or "bad" verdict before checking its coverage, and check a new ad's coverage before it passes about
SAR 50 (or equivalent) spend. Coverage is the conversions the project attributes to the channel in its own data, such as stored UTM
source, divided by the platform's click-based conversions for the same window; view-through results never count. Below 70%, call the
channel unjudgeable and fix tracking first. When the platform counts an earlier step than the project's own record (a tap against an
install), say the ratio is a floor.
