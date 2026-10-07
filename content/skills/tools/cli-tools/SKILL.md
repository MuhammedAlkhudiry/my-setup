---
name: cli-tools
description: Use to find icons, deploy to or manage Cloudflare, manage Laravel Forge servers and sites, or read PostHog data from the command line.
---

Before you run a command, read that CLI's help for it. The help decides which commands and options exist.

- **Cloudflare:** `cf cli search "<task>"` finds the command; then read `<command> --help`. Keep search queries anonymous: describe the action and
  resource type, never names, domains, or IDs. Use `cf` instead of wrangler, the API, or the dashboard.
  - Deploy a static site from a staging folder outside the repository. It needs a `package.json` with `cf` and `wrangler` as dev dependencies, a
    `cloudflare.config.ts` naming the Worker, and a `wrangler.config.ts` whose `assetsDirectory` points at the build output. Run the dry run
    first, then deploy. Free static assets allow 25 MiB per file and 20,000 files.
  - The first Worker deploy on an account needs a `workers.dev` subdomain, and `cf` has no command for it. Ask the user for the name, then set
    it with `PUT /accounts/{account_id}/workers/subdomain` using the `cf` OAuth token.
  - For sign-in, use $service-access.
- **Hugeicons:** `hugeicons --help`.
- **Laravel Forge:** `forge list` and `forge help <command>`. Use the CLI Herd installs, which comes first on `PATH`; the Composer copy at
  `~/.composer/vendor/bin/forge` (1.8.3) answers "not found" for every server and site. Before a command that changes a server or site, check
  the active organization and server. Use the CLI instead of the Forge API or dashboard.
  - Production output can hold customer data and secrets; never print or summarize `.env` values. Run `.env` pulls or pushes, deploys,
    restarts, migrations, and `tinker` only when the task calls for them. Prefer `forge daemon:*` over `supervisorctl`, which needs `sudo`.
- **PostHog:** `posthog-cli api --agent-help`. For sign-in or credentials, use $service-access.
