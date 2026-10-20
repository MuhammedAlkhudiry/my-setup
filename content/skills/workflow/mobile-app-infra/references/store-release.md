# Store Release

Read [store CLI credentials and boundaries](store-clis.md). Resolve the branch and local changes, project version strategy, native build numbers,
build/submit profiles, app identifiers, store targets, signed artifact, and metadata from project instructions, Expo config, `eas.json`, and live
account state. Run project verification and use its established versioning, build, and submission path.

Continue an authorized release until every app is waiting for review or the store's equivalent, without another confirmation. Stop for required
rebuilds, signing/provisioning failures, version conflicts, policy rejection, or unresolved compliance, pricing, privacy, or availability decisions.
Hand off the exact manual step when an authorized API cannot perform it.

Reuse artifacts already in the store. Report artifact and submission IDs, signing identity, native versions, links, timestamps, and live state.
Keep `built`, `submitted`, `waiting for review`, `in review`, `rolling out`, and `live` distinct.

## Local Builds

Build on the Mac and upload with EAS Submit; paid EAS cloud builds are the exception. From the app folder, use
`store-build <ios|android> <submit-profile>`, usually through the project's script.

- Always name the submit profile: it can release straight to production. Prove new build paths with TestFlight or an internal track.
- Supply EAS secret variables locally; file secrets need absolute paths. Use `--allow-missing` only for secrets the platform does not use.
- Local builds use the Mac's Xcode, JDK, and Android SDK. If an older pinned Xcode major blocks local iOS, use `--cloud`.
- Repair App Group provisioning failures using the printed credential steps; never bypass the check, which also runs for cloud builds.
- `--dry-run` installs and verifies the exact local build plugin required by the installed EAS CLI in a versioned user cache outside the project;
  it runs no build or submission. Set `EAS_LOCAL_BUILD_PLUGIN_PATH` to use an existing binary, which is verified too.
- Retry failed uploads with the preserved archive and printed command; do not rebuild to resubmit.

Ship changes in store builds. Publish over-the-air updates only when the owner asks; keep that tooling working.

## TestFlight Only

Use EAS and $asc-testflight-orchestration to deliver a processed `VALID` build to the named tester groups. Do not create/update an App Store version
or submit for App Review. Get approval before submitting for external Beta App Review; internal groups need no review. Report build number,
processing state, and groups that can install it.

## App Store Version Preparation

Use $asc-release-flow to stage the processed build, carrying forward the previous version's localized metadata. Use $asc-metadata-sync for new
release notes in each locale. Copy missing review contacts from the previous version; use $asc-submission-health for readiness and rejected
submissions, reusing the unresolved submission after attaching the fixed build.

Apply the [mutation flags policy](store-clis.md#safety) only where flags exist: `asc localizations update` has no `--dry-run`, and
`asc review details-create` has neither `--dry-run` nor `--confirm`.

## Rollout

Release to all users at once. Remove any App Store phased-release record before submission; use the [direct status check](store-status-apis.md)
to verify its absence.

EAS submits Android to the configured track. Promote with `gpc releases promote --from <track> --to production --status completed`; never pass
`--rollout`. Finish an existing `inProgress` release with `gpc releases rollout complete`.
