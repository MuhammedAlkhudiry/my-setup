# Store Status

Follow [store CLI policy](store-clis.md). Use read-only checks; never prepare or submit to obtain status.

- EAS: `eas build:list --json` shows build progress. Check submission and store state separately.
- App Store: use $asc-submission-health for status and blockers. `phasedRelease.configured` in app status can be a false positive; verify with
  `ASC_READ_ONLY=1 asc versions phased-release view --version-id <id>`.
- Google Play: `gpc --ci releases status --app <package>` shows every track, its version codes, status, and release notes. Add `gpc status` for
  vitals and recent reviews.

Match project, artifact, signing identity, native version, and track. Distinguish processing, review, rollout, and availability; a build, upload,
successful API request, or configured rollout does not prove `live`.
