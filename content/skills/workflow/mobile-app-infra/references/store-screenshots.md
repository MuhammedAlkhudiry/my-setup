# Store Screenshots

Use the [store CLIs](store-clis.md). Generate and visually approve the numbered PNG files through the target project's own screenshot workflow before
uploading them.

- App Store: `asc screenshots upload --app <id> --version <version> --locale <locale> --path <dir> --device-type <type> --replace`. Run it with
  `--dry-run` first, then with `--confirm`. `asc screenshots sizes` lists device types.
- Google Play: `gpc listings images sync --app <package> --dir <dir> --lang <language> --type phoneScreenshots --delete`. Run it with `--dry-run`
  first. `--delete` removes remote images missing locally and fixes display order.
- Screenshot replacement is destructive and requires explicit confirmation. App Store replacement is not transactional; rerun the exact approved set
  after interruption. Cross-store replacement can partially succeed, so report each provider independently.
- Verify the final provider state with `asc screenshots list` and `gpc listings images list`, plus the public listings when version visibility
  matters.
