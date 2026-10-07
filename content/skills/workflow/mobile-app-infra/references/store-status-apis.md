# Store Status

Use the [store CLIs](store-clis.md) with read-only commands only; never use a preparation or submission action as a status check.

- EAS: `eas build:list --json --non-interactive` proves build and upload progress. Store CLIs prove review, rollout, and availability.
- App Store: `ASC_READ_ONLY=1 asc status --app <id>` shows builds, TestFlight, the App Store version, submission blockers, review, and phased release.
  Use `ASC_READ_ONLY=1 asc review doctor --app <id>` to explain a blocked or rejected version.
- Google Play: `gpc --ci releases status --app <package>` shows every track, its version codes, status, and release notes. Add `gpc status` for
  vitals and recent reviews.
- Keep project, artifact, signing identity, native version, track, processing, review, rollout, and availability distinct.
- Never infer `live` from a build, upload, successful API request, or configured rollout.
- Never automate App Store Connect or Google Play Console through a browser, except a declaration form the API cannot edit when the owner asks for
  that change. Report other API-unsupported store tasks as explicit manual blockers.
