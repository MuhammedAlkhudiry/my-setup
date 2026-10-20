---
name: cli-tools
description: Use for Hugeicons, Cloudflare, Laravel Forge, or PostHog CLI work.
---

Read live command help; do not guess commands or flags.

- **Cloudflare:** use `cf` instead of wrangler, raw API calls, or the dashboard. Discover commands with `cf cli search "<task>"`; describe only the
  action and resource type, never names, domains, or IDs.
  - Deploy static sites from a staging folder outside the repository; dry-run first. Use `cf docs search` for current configuration and asset limits.
  - First Worker deployment needs a `workers.dev` subdomain. If `cf` still lacks a command, ask for the name and set it through
    `PUT /accounts/{account_id}/workers/subdomain` with the `cf` OAuth token.
- **Hugeicons:** use `hugeicons`.
- **Laravel Forge:** discover with `forge list` and `forge help <command>`. Use Herd's CLI, first on `PATH`; the Composer copy at
  `~/.composer/vendor/bin/forge` returns false "not found" errors. Use the CLI first; where it lacks a command, use the API as $service-access describes, never the dashboard.
  - Confirm the active organization and server before mutations. Never print or summarize `.env` values. Pull/push environments, deploy,
    restart, migrate, or run `tinker` only within task scope. Prefer Forge's background-process commands over `supervisorctl`, which needs `sudo`.
- **PostHog:** use $querying-posthog-data for data questions and `posthog-cli api --agent-help` for CLI mechanics.

For sign-in or credentials, use $service-access.
