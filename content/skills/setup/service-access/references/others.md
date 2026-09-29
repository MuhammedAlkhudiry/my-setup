# Other providers

## Cloudflare

Use `cf auth whoami` as the access check. To repair it, run `cf auth login` in the background; it opens a device-approval page in the user's
signed-in browser and prints the code. Ask the user to approve it, then check again. The OAuth token lasts about an hour; rerun the login when it
expires.

Wrangler keeps its own separate sign-in. For a tool that still calls wrangler, check it with `bunx wrangler whoami` and repair it with
`bunx wrangler login --browser=false`, approving the printed URL in the user's signed-in browser. Neither CLI manages Zero Trust Access; change
Access applications in the dashboard.

## DigitalOcean

Use `doctl` and its live help for authentication and a read-only access check.

## PostHog

Use $cli-tools. Check the installed credential template and current environment before requesting credentials; use live agent help to repair access.
