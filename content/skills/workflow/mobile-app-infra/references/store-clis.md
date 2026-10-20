# Store CLIs

Use `asc` for App Store Connect, `gpc` for Google Play, and EAS for builds and submissions. Use $asc-cli-usage for command discovery and live help
for flags. The policies here override remote ASC skills.

## Credentials

- Load and export the project's release environment in the same shell as the CLI call, usually from
  `$SERVICE_CREDENTIALS_HOME/environments/<project>/mobile-release.env`.
- Use `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH`, and `GPC_SERVICE_ACCOUNT`. Never create `asc auth login` or `gpc auth login`
  profiles; keep a separate Google Play service account per project.
- Use $service-access when the file, key, or store permission is missing.

## Identifiers

- Take the App Store Connect app ID from `submit.production.ios.ascAppId` in `eas.json`, and the Android package and version from the Expo config.
- `gpc status` exits 0 and prints no releases for an unknown package. Use `gpc --ci releases status --app <package>` when the result must fail on a
  wrong package.

## Safety

- Prefix read-only `asc` calls with `ASC_READ_ONLY=1`; it refuses every mutating request.
- Preview mutations with `--dry-run` before applying with `--confirm` (`asc`) or `--yes` (`gpc`); use each flag only where live help supports it.
- Never use `asc web` commands. They drive an Apple Account web session, which counts as browser automation of App Store Connect.
- Routine store work is API/CLI-only. Browser automation is allowed only for an API-unsupported declaration form when the owner asks for that
  change. Other API-unsupported account, policy, legal, payment, and review tasks are manual blockers requiring fresh user intent.
