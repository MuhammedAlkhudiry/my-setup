---
name: tool-updates
description: Use when updating the machine's external CLI tools and reporting what changed across the versions crossed.
---

## Workflow

1. Run `system-tools status`, then `system-tools update-plan`. Use their live output to determine which tools can be updated and how.
2. Run only eligible update commands from the plan. After a runtime-manager or Node upgrade, re-check its global CLIs and repair missing commands from
   their documented package source.
3. Re-run `system-tools status` until every eligible tool is current or has a specific blocker.
4. For each updated tool, read the official release notes or changelog for every version crossed. Do not infer changes when official notes are
   unavailable.

## Report

- Lead with each updated tool as `<tool>: <old version> → <new version>`.
- Under each tool, summarize notable new capabilities, behavior or configuration changes, breaking changes, and meaningful bug or security fixes
  across the versions crossed.
- Then report repairs needed after runtime upgrades, blockers or warnings, and one compact verification result.
- Omit unchanged or ineligible tools, routine maintenance, and unsupported claims. State when official notes are unavailable or when no updates were
  needed.
