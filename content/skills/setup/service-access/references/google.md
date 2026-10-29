# Google

## Google Cloud

Use `gcloud` and live help. Keep authentication in `~/.config/gcloud/`; verify the intended project with a read-only description. Enable only required
APIs; pause for OAuth or new IAM grants.

## Google Drive

Use `rclone` and live help for authentication and a read-only check.

<!-- profile:personal -->

## Gmail

Read mail with `mail-read`; see [Email](others.md#email).

<!-- /profile -->

## Google Play

Use `gpc` through $mobile-app-infra. Reserve Play Console browser work for explicit user-run account, policy, legal, payment, or review tasks outside
the API. Load the project's service account from `mobile-release.env`; verify with `gpc --ci releases status --app <package>`. Keep keys in
agent-managed storage; pause for key creation or Play Console grants.

### Android vitals and crash clusters

Read them through the Play Developer Reporting API, enabled on the service account's own Cloud project (`project_id` in its key). The account
needs Play Console's "View app information and download bulk reports" permission; a 403 means that grant is missing. Mint a token in a throwaway gcloud config so the
user's active account stays untouched:

```sh
export CLOUDSDK_CONFIG="$(mktemp -d)"
gcloud auth activate-service-account --key-file="$GOOGLE_SERVICE_ACCOUNT_KEY" -q
TOKEN="$(gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/playdeveloperreporting)"
BASE=https://playdeveloperreporting.googleapis.com/v1beta1/apps/<package>
```

- **Freshness:** `GET $BASE/crashRateMetricSet` returns the latest complete `HOURLY` and `DAILY` period. Queries ending later fail with 400.
- **Crash rate:** `POST $BASE/crashRateMetricSet:query` with a `timelineSpec` (`aggregationPeriod`, `startTime`, `endTime` in the `DAILY`
  time zone) and `metrics` such as `crashRate`, `userPerceivedCrashRate`, `crashRate28dUserWeighted`, and `distinctUsers`. The same shape
  works for `anrRateMetricSet`. An empty `{}` is a valid result: Play withholds rates below its minimum user volume.
- **Crash clusters:** `GET $BASE/errorIssues:search?pageSize=20` lists clusters with cause, report and user counts, last report time, and a
  Play Console `issueUri`; `GET $BASE/errorReports:search` returns individual stack traces.
