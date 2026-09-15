---
name: service-access
description: Configured service access and credential repair.
---

Read only the reference for the requested provider. If none matches, this skill does not cover that provider.

## References

- Advertising platforms: [references/ads.md](references/ads.md)
- Apple services: [references/apple.md](references/apple.md)
- Google services other than Google Ads: [references/google.md](references/google.md)
- Remaining configured providers: [references/others.md](references/others.md)

## Workflow

1. Check existing connections, sign-ins, runtime access, and `$SERVICE_CREDENTIALS_HOME` before requesting credentials.
2. Follow the provider reference and verify access with its smallest read-only check.
3. Repair missing access, pausing only for OAuth, 2FA, new permissions, or credentials the user must create.
4. Keep each provider’s own sign-in data in its normal location. Store agent-managed credentials under `$SERVICE_CREDENTIALS_HOME/<provider>/` with
   directories at mode 700 and files at mode 600.

Report how access works, whether it is ready, and where credentials are stored without exposing their values.
