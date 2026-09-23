# Other providers

## Cloudflare

Use `bunx wrangler whoami` as the access check. To repair it, run `bunx wrangler login --browser=false` and approve the printed URL in the user's
signed-in browser. Wrangler cannot manage Zero Trust Access; change Access applications in the dashboard.

## DigitalOcean

Use `doctl` and its live help for authentication and a read-only access check.

## PostHog

Use $cli-tools. Check the installed credential template and current environment before requesting credentials; use live agent help to repair access.
