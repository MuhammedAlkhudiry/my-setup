---
name: mobile-app-infra
description: Use when working on Expo or React Native development ports and HTTPS trust, simulator or emulator slimming, native sign-in, in-app payments, or EAS and app-store releases.
---

## Routing

Load only the relevant references:

- [Development ports](references/dev-ports.md) for local connection, HTTPS trust, and reload failures.
- [Device slimming](references/device-slimming.md) for reducing simulator and emulator memory without breaking app features.
- [Social sign-in](references/social-sign-in.md) for provider sign-in and verification of signed apps.
- [In-app payments](references/in-app-payments.md) for implementing and testing purchases.
- [Store CLIs](references/store-clis.md) for `asc` and `gpc` credentials, identifiers, and safety rules before any store command.
- [Store release](references/store-release.md) for building, TestFlight distribution, and releasing apps.
- [Store screenshots](references/store-screenshots.md) for App Store Connect or Google Play screenshot replacement.
- [Store status](references/store-status-apis.md) for read-only EAS, Google Play, and App Store Connect checks.

Use $service-access for access setup before asking for store or identity-provider credentials.
