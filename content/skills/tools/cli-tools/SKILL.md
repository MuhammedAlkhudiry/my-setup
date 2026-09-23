---
name: cli-tools
description: Use to find icons, manage Laravel Forge servers and sites, or read PostHog data from the command line.
---

Before you run a command, read that CLI's help for it. The help decides which commands and options exist.

- **Hugeicons:** `hugeicons --help`.
- **Laravel Forge:** `forge list` and `forge help <command>`. Herd installs this CLI. Before a command that changes a server or site, check the active
  organization and server. Use the CLI instead of the Forge API or dashboard.
- **PostHog:** `posthog-cli api --agent-help`. For sign-in or credentials, use $service-access.
