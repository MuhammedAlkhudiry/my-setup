# Google

## Google Cloud

Use `gcloud` and live help. Keep authentication in `~/.config/gcloud/`; verify the intended project with a read-only description. Enable only required
APIs; pause for OAuth or new IAM grants.

## Google Drive

Use `rclone` and live help for authentication and a read-only check.

## Google Play

Use `gpc` through $mobile-app-infra. Reserve Play Console browser work for explicit user-run account, policy, legal, payment, or review tasks outside
the API. Load the project's service account from `mobile-release.env`; verify with `gpc --ci releases status --app <package>`. Keep keys in
agent-managed storage; pause for key creation or Play Console grants.
