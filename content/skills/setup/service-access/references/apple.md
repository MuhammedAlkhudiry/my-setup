# Apple

## App Store Connect

- Use the `asc` CLI through $mobile-app-infra, not browser automation or `asc web` sessions. The project's `mobile-release.env` supplies the API key;
  verify access with `ASC_READ_ONLY=1 asc apps list`.
- Keep the API key in agent-managed credential storage. Pause when the user must create or download it.

## Sign in with Apple

- Match the integration's service or bundle ID, team and key IDs, redirect URLs, runtime key path, and signing identity. Verify with a non-destructive
  sign-in.
- Repair mismatched identifiers, keys, or return URLs in the Apple developer account. Keep private keys in runtime secret storage unless local agent
  access requires `$SERVICE_CREDENTIALS_HOME/apple-sign-in/`.
