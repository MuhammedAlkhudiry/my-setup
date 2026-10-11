---
name: service-access
description: Use for provider sign-in, credentials, access repair, or advertising accounts, campaigns, conversions, and lead flow.
---

Read the reference for the requested provider in the skill reference folder.

## Access guidance

- Existing connections, provider sign-ins, runtime access, and `$SERVICE_CREDENTIALS_HOME` are the first sources to check before requesting
  credentials.
- The provider reference defines the access route. Its smallest read-only check confirms whether access works.
- OAuth, 2FA, new permissions, and credentials the user must create require user action. Repair other missing access directly.
- Keep provider sign-in data in its normal location. Store agent-managed credentials under `$SERVICE_CREDENTIALS_HOME/<provider>/`, with directories
  at mode 700 and files at mode 600.

## Advertising

Read [advertising providers](references/ads.md) for access routes. Read the project's `docs/ads.md`; create it when missing and update it when
the advertising setup changes. Keep these facts there:

- **Scope:** purpose, destinations, promoted apps, and exclusions.
- **Accounts:** platform, manager, name, ID, currency, timezone, access, and ownership.
- **Conversions:** outcomes, events, source, destination, attribution, deduplication, and qualification.
- **Campaigns:** platform, IDs, name, relevance, status, objective, placement, app, budget, bids, dates, destination, and observation time.
- **Lead flow:** source, consent, CRM, deduplication, response owner, and qualified-lead definition.
- **Open questions:** unresolved project relationships, access gaps, unavailable data, and needed follow-up.
