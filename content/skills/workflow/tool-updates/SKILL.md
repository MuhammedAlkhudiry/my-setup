---
name: tool-updates
description: Use when updating the machine's external CLI tools.
---

## Workflow

1. Run `system-tools status`, then `system-tools update-plan`; execute only eligible updates from the live plan.
   Before installing Node alongside an active build, temporarily pin mise's current version and preserve its `latest` link:
   installing a newer version can advance that link even without `mise use`. Restore the default only after the build exits.
2. After runtime-manager or Node upgrades, recheck global CLIs and restore missing commands from documented package sources.
3. Rerun `system-tools status` until every eligible tool is current or has a specific blocker.
4. Read official release notes/changelogs for every version crossed; do not infer missing changes.

## Report

- For each updated tool: `<tool>: <old version> → <new version>`, then notable capabilities, behavior/configuration changes, breaking changes,
  and bug/security fixes across those versions.
- Follow with runtime repairs, blockers/warnings, and one verification result.
- Omit unchanged/ineligible tools, routine maintenance, and unsupported claims. State when official notes are unavailable or no updates were needed.
