# Store CLIs

Use `asc` for App Store Connect and `gpc` for Google Play. EAS stays the build and submission path. Read live help before each unfamiliar command:
`asc search "<task>"`, `asc <command> --help`, and `gpc <command> --help`. Use $asc-cli-usage, $asc-release-flow, $asc-submission-health,
$asc-testflight-orchestration, and $asc-metadata-sync for `asc` workflow detail; the rules below take precedence over them.

## Credentials

- Load the project's release environment file, usually `$SERVICE_CREDENTIALS_HOME/environments/<project>/mobile-release.env`, with
  `set -a; source <file>; set +a` in the same shell command as the CLI call.
- The file exports `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY_PATH` for `asc`, and `GPC_SERVICE_ACCOUNT` for `gpc`. Do not create
  `asc auth login` or `gpc auth login` profiles; each project keeps its own Google Play service account.
- Use $service-access when the file, key, or store permission is missing.

## Identifiers

- Take the App Store Connect app ID from `submit.production.ios.ascAppId` in `eas.json`, and the Android package and version from the Expo config.
- `gpc status` exits 0 and prints no releases for an unknown package. Use `gpc --ci releases status --app <package>` when the result must fail on a
  wrong package.

## Safety

- Prefix read-only `asc` calls with `ASC_READ_ONLY=1`; it refuses every mutating request.
- Preview a mutation with `--dry-run` before running it with `--confirm` (`asc`) or `--yes` (`gpc`).
- Never use `asc web` commands. They drive an Apple Account web session, which counts as browser automation of App Store Connect.
