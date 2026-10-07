# Viewed files

Once the pull request exists and its last push is done, run the skill's `bun scripts/mark-viewed.ts <pr-url>` to tick GitHub's Viewed box on
files that need no line-by-line review, so the reviewer opens only what matters. Use `--dry-run` to preview.

- **Ticked:** tests, lock files, generated files such as snapshots, and assets.
- **Left for review:** app code, docs, and migrations.
- **Test files left for review:** deleted files, diffs that remove or change a test or assertion, and diffs that add a skip or focus marker. Only
  added or extended tests are ticked.

The tick belongs to the account `gh` uses, and GitHub clears it when the file changes, so run the script again after every later push. In the 📏
Review size table, add ✅ to each row the script ticked, and list the test files it left for review with its reason.
