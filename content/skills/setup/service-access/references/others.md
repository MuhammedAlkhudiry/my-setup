# Other providers

## Cloudflare

Use `cf auth whoami` as the access check. To repair it, run `cf auth login` in the background; it opens a device-approval page in the user's
signed-in browser and prints the code. Ask the user to approve it, then check again. The token refreshes itself; log in again only when `whoami` reports
`"authenticated": false`.

`cf` does not manage Zero Trust Access; change Access applications in the dashboard.

## DigitalOcean

Use `doctl` and its live help for authentication and a read-only access check.

## PostHog

Use $cli-tools. Check the installed credential template and current environment before requesting credentials; use live agent help to repair access.
