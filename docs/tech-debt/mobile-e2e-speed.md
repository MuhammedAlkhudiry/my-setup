# Mobile E2E speed

Awraq's and Harium's Maestro suites spend most of each test on start-up and on checks for things that are not on screen. Postponed by the owner on
2026-10-05 after a measured trial; due before either suite runs in CI or on a schedule, or when a full local run blocks a release.

## Evidence

Awraq, iOS, 6 flows, start-up and login helpers changed only: 5 comparable flows went from 1,237 s to 343–385 s, and passes went from 5 of 9 runs
to 12 of 12. Each check for an absent element (`optional: true` taps, `runFlow: when: visible`) cost about 7 s, a fixed Maestro lookup timeout
that no config changes. Per-command times come from `commands.json` under `maestro test --debug-output`.

## How to complete

1. Start the Expo dev client with nothing to dismiss, then wait only for the first app screen:

   ```yaml
   - launchApp:
       arguments:
         "-EXDevMenuShowsAtLaunch": "NO"
         "-EXDevMenuIsOnboardingFinished": "YES"
   - openLink: "exp+<slug>://expo-development-client/?url=${encodeURIComponent(MAESTRO_METRO_URL)}"
   ```

   - Maestro passes iOS launch arguments verbatim, so the leading dash is what makes them `UserDefaults` overrides.
   - `disableOnboarding=1` works only inside the inner Metro URL, not on the outer link.
   - The `exp+<slug>` scheme keeps the app's own deep-link handling from receiving the link.
   - Untested on Android, where launch arguments do not set the dev-menu preferences.
   - Harium saw a native crash when linking while a bundle was already loading; verify there first.

2. Delete checks for popups that never appear, and prevent the ones that do. Some removed checks were accidental waits: put
   `waitForAnimationToEnd` before taps on sheets and modals that slide in.
3. Awraq: delete `close-local-login-sheet.yaml`, which never matched, and give every login flow one shared promotion-dismiss helper.
   `account-member-exports` fails on `main` because the member login lacks it.
4. Bring Harium's runner safeguards to Awraq: retry once with flaky reporting, a per-flow timeout, a check for frozen Android emulators (Maestro
   scans them even on iOS runs and hangs), and artifact pruning.
5. Unmeasured next step: stop wiping the app before every test, which reloads the JS bundle each time (about 24 s in Awraq). Use a dev-only
   in-app reset link, or an end-to-end build with the bundle embedded and the dev tools kept behind a flag.
6. Prevent regressions with a lefthook check that fails on `optional: true` and visibility conditions in shared flows, and a rule in
   `$test-writing`.

Done when each suite passes in full on iOS and Android with per-flow times recorded before and after.
