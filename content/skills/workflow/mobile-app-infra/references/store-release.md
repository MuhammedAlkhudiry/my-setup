# Store Release

Use project instructions, release scripts, Expo config, `eas.json`, verification requirements, current CLI help, provider documentation, API schemas,
and live account state as the release contract.

## Workflow

1. Resolve the target branch, local changes, version strategy, native build numbers, build and submit profiles, app identifiers, store targets, signed
   artifact identity, verification, and release metadata.
2. Use $service-access for EAS, Google Play, App Store Connect, Google Cloud, or Sign in with Apple access.
3. Run project-owned verification. Change versions only through the discovered version strategy and use the established build and submission path.
4. Capture artifact IDs, signing identity, native versions, submission IDs, links, timestamps, and the exact live state from EAS and each store.
5. Promote or attach an artifact already present in a store instead of rebuilding or uploading it only to obtain status.
6. Continue through every available release step until each app is waiting for review or reaches the store's equivalent state. Do not stop at an
   intermediate status or ask for another confirmation.

Keep `built`, `submitted`, `waiting for review`, `in review`, `rolling out`, and `live` distinct. Stop only for rebuild requirements, signing or
provisioning failures, version conflicts, policy rejection, or unresolved product decisions about rollout, compliance, pricing, privacy, or
availability. When an authorized API cannot perform a required action, hand off that exact manual step.

Routine store releases are API/CLI-only: use EAS for builds and submissions and the [store CLIs](store-clis.md) for status, rollout, listings, and
other supported release operations. Never automate App Store Connect or Google Play Console through a browser, except a declaration form the API
cannot edit, such as Play's App content, when the owner asks for that change. Treat other API-unsupported account, policy, legal, payment, and
review tasks as explicit manual blockers requiring fresh user intent.

## Local Builds

Build store artifacts on the Mac and upload them with EAS Submit; paid EAS cloud builds are the exception. From the app folder, run
`store-build <ios|android> <submit-profile>`, usually through the project's own script; `store-build --help` lists the options.

- The submit profile is always explicit, because a profile can release straight to production. Prove a new build path with a profile that
  targets TestFlight or an internal track.
- EAS keeps secret variables from local builds, so `store-build` stops until each is set locally; a file secret takes an absolute path, and
  `--allow-missing` skips a secret the platform does not use.
- A local build uses the Mac's Xcode, JDK, and Android SDK, not the `eas.json` image. `store-build` refuses local iOS while a project pins an
  older Xcode major, and `--cloud` builds that platform on EAS.
- A failed upload keeps the archive and prints the retry command; never rebuild only to resubmit.

Ship every change in a store build. Publish an over-the-air update only when the owner asks for one, and keep the update tooling working so
it is ready when they do.

## TestFlight Only

When the user asks for TestFlight instead of a store release, the target state is a processed build available to testers, not waiting for review.

- Build and upload through the established EAS path. Confirm the build's processing state is `VALID` with `asc builds info` or
  `asc builds wait`.
- Do not create or update an App Store version, and do not submit for App Review.
- Make the build available to the tester group the user names with $asc-testflight-orchestration. Internal groups need no review. An external group
  needs Beta App Review, which is a submission; get the user's approval first.
- Report the build number, processing state, and the groups that can install it.

## App Store Version Preparation

Use `asc` through the [store CLIs](store-clis.md) and $asc-release-flow. Run each mutating command with `--dry-run` first, then `--confirm`.

1. Resolve the processed build's ID with `asc builds list`, and the latest earlier App Store version.
2. Stage the version with `asc release stage --app <id> --version <version> --build-id <build-id> --copy-metadata-from <previous-version>`. It creates
   the version when missing, copies localized metadata, attaches the build, and runs readiness checks.
3. Set the new release notes for each locale with `asc localizations update --version <version-id> --locale <locale> --whats-new <text>`.
4. Run `asc review doctor --app <id>`. When App Review contact details are missing, copy them from the previous version with
   `asc review details-for-version` and `asc review details-create`.
5. Submit with `asc review submit --app <id> --version <version> --build-id <build-id>`. When App Review rejected the version, attach the fixed build
   and resubmit the existing unresolved submission with `asc review submissions-submit --id <submission-id>`; follow $asc-submission-health.

## Google Play Rollout

EAS submits Android builds to the configured track. Use `gpc` for later promotion and rollout changes, such as
`gpc releases promote --from <track> --to production --rollout <percent>` and `gpc releases rollout increase`. Rollout percentage is a product
decision; do not choose it without the user's instruction or the project's release instructions.
