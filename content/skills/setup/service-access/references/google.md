# Google

## Google Cloud

- Use `gcloud` and its live help. Keep authentication under `~/.config/gcloud/` and verify the intended project with a read-only description.
- To repair access, authenticate, select the intended project, and enable only the required API. Pause for OAuth or new IAM grants.

## Google Drive

- Use `rclone` and its live help for authentication and a read-only access check.

## Google Play

- Use the Google Play Developer API through $mobile-app-infra. Keep Play Console browser tasks for explicit user-run account, policy, legal, payment,
  or review work the API cannot perform.
- Read the selected script's live help and installed environment template for credentials, then verify access with the read-only Android store-status
  command.
- Keep the service-account key in agent-managed credential storage. Pause when the user must create the key or grant Play Console access.
