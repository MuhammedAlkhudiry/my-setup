# Apple

## App Store Connect

Use `asc` through $mobile-app-infra, never browser automation or `asc web`. Load the project's `mobile-release.env`; verify with
`ASC_READ_ONLY=1 asc apps list`. Keep keys in agent-managed storage; pause when the user must create or download one.

## Sign in with Apple

Match service/bundle ID, team/key IDs, redirect URLs, runtime key path, and signing identity; verify with a non-destructive sign-in. Repair mismatches
in the developer account. Keep keys in runtime secret storage unless local agent access needs `$SERVICE_CREDENTIALS_HOME/apple-sign-in/`.
