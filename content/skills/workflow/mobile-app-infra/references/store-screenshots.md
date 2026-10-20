# Store Screenshots

Read [store CLI policy](store-clis.md). Generate and visually approve numbered PNGs through the project's screenshot workflow before upload.

- App Store: use $asc-cli-usage and live screenshot-upload help for replacement flags and device types.
- Google Play: `gpc listings images sync --app <package> --dir <dir> --lang <language> --type phoneScreenshots --delete` removes missing remote
  images and fixes display order.
- Replacement is destructive and needs explicit confirmation. App Store replacement is not transactional; rerun the approved set after interruption.
  Report each provider independently after partial success.
- Verify remote screenshot lists and public listings when version visibility matters.
