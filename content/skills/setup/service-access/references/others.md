# Other providers

## Cloudflare

Check `cf auth whoami`; log in again only when it reports `"authenticated": false`. Run `cf auth login` in the background, ask the user to approve
the browser device flow, then recheck. Use $cli-tools for Cloudflare operations, including Zero Trust Access applications.

## Laravel Forge

Herd's `forge` CLI is already signed in; `forge server:current` confirms the organization and server. Its API token sits in
`~/.laravel-forge/config.json` under `token`; never print it. When the CLI lacks a command, such as reading or saving a site's deploy
script, call the Forge API with that token as a bearer token (`https://forge.laravel.com/api/...`; endpoints in the
[OpenAPI spec](https://forge.laravel.com/api/docs.openapi)). Never use the dashboard; its login has no Google sign-in. Back up anything you
change first.

## DigitalOcean

Use `doctl` and live help for authentication and a read-only check.

## PostHog

Use $cli-tools; check the installed credential template and environment before requesting credentials. Repair access using live agent help.

## OpenAI access

Check `$SERVICE_CREDENTIALS_HOME/openai/` and environment for `OPENAI_ADMIN_KEY`; ordinary project inference keys do not grant organization
billing access. Google sign-in works in the owner’s signed-in Chrome; choose Continue with Google, then the API organization owning the production projects.
With explicit owner authorization, create an API Platform key at [Organization → Admin keys](https://platform.openai.com/settings/organization/admin-keys).
The read-only `housekeeper-readonly` key is stored as `OPENAI_ADMIN_KEY` in `$SERVICE_CREDENTIALS_HOME/openai/admin.env` (directory 700, file 600).
The local Housekeeper `openai-spend.ts` loads this file when `OPENAI_ADMIN_KEY` is unset. Never print secrets or include unredacted key dialogs in snapshots.

[Admin keys](https://developers.openai.com/api/docs/guides/admin-apis) cannot run inference. The dashboard offers Read only (verified 2026-10-19); select it for spend monitoring. The documented create API exposes no per-endpoint
scope parameter; do not assume API-created keys have the same restrictions. Required access is organization usage/costs read; project discovery also needs
organization project read. If the dashboard offers restrictions, grant only those reads, then verify Costs access. No mutation permission is
needed by a spend reader. Keep the admin key off production application servers.

## OpenAI spend API

Use `GET /v1/organization/costs` with Unix `start_time`, `end_time`, `bucket_width=1d`, and `group_by=project_id`; follow `has_more`/`next_page`.
Sum USD `amount.value` for costs, including null-project and other-project charges in organization totals. Use UTC calendar months/days;
reported costs may lag. Project IDs from production response headers identify which app incurred each charge; never infer identity from a key prefix.

[Costs and Usage](https://developers.openai.com/cookbook/examples/completions_usage_api) need an Admin key. `/v1/organization/usage/*` reports
activity for completions, embeddings, images, audio transcriptions/speeches, moderations, vector stores and tool sessions/calls; supported
filters and grouping vary. Prefer Costs over token-price estimates for budget checks.

Project `/rate_limits` and response `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` describe throughput, not money or remaining credits
([rate limits](https://developers.openai.com/api/docs/guides/rate-limits)). Organization/project `/spend_limit` and `/spend_alerts` expose hard
caps and alerts separately; hard caps can stop API traffic. Read-only monitoring must not change them.

## OpenAI prepaid continuity

No public documented API exposes prepaid balance, auto-recharge enabled state, threshold, recharge amount or recharge ceiling. Do not use
legacy dashboard billing routes as a supported API or subtract spend from an assumed balance. Use a signed-in owner browser at
[Billing overview](https://platform.openai.com/settings/organization/billing/overview), select the correct organization, and read balance,
auto-recharge settings, payment method and monthly recharge ceiling. Use the browser’s existing Google account for sign-in; stop for passwords, 2FA codes, or phone prompts. Never change billing during read-only verification.

Housekeeper must flag unreadable costs and spend above 80% of the owner's budget, retain immediate credit/quota-error alerts, and check
prepaid funding separately. A recharge ceiling limits purchases, not usage; manual top-ups and carried credits differ from monthly spend.
Escalate before credits or the budget run out: a fixed budget cannot guarantee uninterrupted service at unlimited demand. Never silently
increase spending or stop traffic. Distinguish billing/quota errors from temporary rate limits; retries cannot replenish credits.

## Claude pool limits

The local CLIProxyAPI pool records each Claude account's limits from Anthropic's rate-limit headers. Read them with
`GET http://127.0.0.1:8317/v0/management/auth-files` and the bearer key in `~/.cli-proxy-api/management-key`: each file's
`model_quotas.<model>.signals` holds `Anthropic-Ratelimit-Unified-{5h,7d}-{Utilization,Reset}` and `-Status`, as of `observed_at`. An
idle account's reading goes stale until its next request.

## Telegram ops bot

Use `telegram-send` with a plain-text message on stdin; it sends one message to the owner. Credentials stay in
`$SERVICE_CREDENTIALS_HOME/telegram/ops-bot.json` (`token`, `owner_chat_id`). Use `telegram-send webhook check` for a read-only
health check. It requires the T3 relay host, no delivery errors within 24 hours, and at most five pending updates.
When T3 regenerates the webhook URL, obtain it from `list_scheduled_tasks` and run `telegram-send webhook set <url>`;
never print the full URL. Pending updates are preserved. Do not use getUpdates polling while the webhook is active.

<!-- profile:personal -->

## Telegram as the owner

`telegram-me` uses the owner's own Telegram account on the main Mac only; its session stays in that Mac's Keychain. Reading needs no
approval: `telegram-me chats [--search <text>]` lists id, type, and title, and `telegram-me read <chat> [--limit n]` prints recent
messages. `<chat>` is an id, an exact title, or `me` for Saved Messages.

Writing to a person or group as the owner needs their yes to the exact recipient and text, every time:

1. Pipe the text into `telegram-me draft <chat>`. It prints the draft id, recipient, and text, and sends the owner a preview through the
   ops bot.
2. Show the owner the same recipient and text, and say they approve by replying "yes" to that Telegram preview.
3. After their reply, run `telegram-me approve <id>`, then `telegram-me send <id>`. Both read the reply from Telegram, so a yes said
   elsewhere, an edited draft, or an edited preview never sends; draft again instead.

Saved Messages need no approval. Never read the session from the Keychain or send outside `telegram-me`. When the session is missing,
`telegram-me login` asks for the api_id, api_hash, phone number, login code, and two-step password in native macOS prompts on the main Mac,
so the owner must be at it; never ask for them in chat.

## Email

`mail-read` reads the owner's Gmail and Hotmail from what the Mail app has synced on the main Mac; it never contacts a mail server, so
reading cannot send, mark as read, move, or delete mail. `mail-read search [text] [--account gmail|hotmail] [--from x] [--since
YYYY-MM-DD] [--unread]` lists newest first by subject, sender, and preview; `mail-read read <id>` prints the headers, text body, and
attachment names; `mail-read accounts` shows each account's newest message. Use it for verification codes and receipts instead of the
browser. Never send, reply to, or change mail through Mail, AppleScript, or a mail server.

<!-- /profile -->
