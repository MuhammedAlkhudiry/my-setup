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

Routine store releases are API/CLI-only: use EAS for builds and submissions and provider APIs for status, rollout, listings, and other supported
release operations. Never automate App Store Connect or Google Play Console through a browser. Treat API-unsupported account, policy, legal, payment,
and review tasks as explicit manual blockers requiring fresh user intent.

## TestFlight Only

When the user asks for TestFlight instead of a store release, the target state is a processed build available to testers, not waiting for review.

- Build and upload through the established EAS path. Confirm the build's `processingState` is `VALID` with `scripts/mobile-store-status.ts`.
- Do not create or update an App Store version, and do not submit for App Review.
- Make the build available to the tester group the user names. Internal groups need no review. An external group needs Beta App Review, which is a
  submission; get the user's approval first.
- Report the build number, processing state, and the groups that can install it.

## App Store Version Preparation

Use the bundled `scripts/mobile-app-store-release.ts` for App Store version preparation and submission. Resolve it relative to this skill, read its
live help, and treat the script as the authority for arguments, defaults, and API behavior. Use `scripts/mobile-store-status.ts` for read-only
inspection; never use a preparation or submission action as a status check.
