---
name: service-access
description: Use when a configured third-party provider needs sign-in, credentials, or access repair before other work can run.
---

Read the reference for the requested provider in the skill reference folder.

## Access guidance

- Existing connections, provider sign-ins, runtime access, and `$SERVICE_CREDENTIALS_HOME` are the first sources to check before requesting
  credentials.
- The provider reference defines the access route. Its smallest read-only check confirms whether access works.
- OAuth, 2FA, new permissions, and credentials the user must create require user action. Repair other missing access directly.
- Keep provider sign-in data in its normal location. Store agent-managed credentials under `$SERVICE_CREDENTIALS_HOME/<provider>/`, with directories
  at mode 700 and files at mode 600.
