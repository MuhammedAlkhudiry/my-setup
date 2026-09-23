# Apple

## App Store Connect

- Use the App Store Connect API through $mobile-app-infra, not browser automation. Read the selected script's live help and installed environment
  template for credentials, then verify access with the read-only iOS store-status command.
- Keep the API key in agent-managed credential storage. Pause when the user must create or download it.

## Sign in with Apple

- Match the integration's service or bundle ID, team and key IDs, redirect URLs, runtime key path, and signing identity. Verify with a non-destructive
  sign-in.
- Repair mismatched identifiers, keys, or return URLs in the Apple developer account. Keep private keys in runtime secret storage unless local agent
  access requires `$SERVICE_CREDENTIALS_HOME/apple-sign-in/`.
