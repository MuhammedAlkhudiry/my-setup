# Advertising platforms

Identify the intended account in the user's signed-in Chrome session. Never inspect or export cookies, session storage, passwords, or tokens.
Pause for login, OAuth, 2FA, CAPTCHA, or missing permissions. Get approval before changing ads, billing, tracking, or account access.

## Google Ads

- Confirm the customer/manager name and ID in [Google Ads](https://ads.google.com/).
- Prefer the API when `GOOGLE_ADS_*` credentials exist in `$SERVICE_CREDENTIALS_HOME/secrets.zsh`; verify by listing accessible customers.
  Keep customer, manager, Cloud project, OAuth user/app, and developer-token owner distinct; choose the task's `login-customer-id`.
- Repair the developer token, enabled API, or OAuth client as needed; update `secrets.zsh`.

## Apple Ads

- Confirm the account, currency, timezone, and role in [Apple Ads](https://app-ads.apple.com/cm/app/).
- A project without Apple Ads API credentials has no API user on purpose: Apple blocks creating its Apple Account from the home
  network, and the owner chose not to deal with it (2026-11-04). Read and export its reports from the signed-in Apple Ads web
  dashboard in the shared browser instead, and never ask the owner to set up API access.
- Prefer `asc ads` where it covers the task. Read `asc ads --help`; the default is Platform API v1, while `asc ads v5` is deprecated.
  Verify credentials with `asc ads auth discover`; use `asc ads auth login` to register keys rather than implementing custom OAuth.
- Platform API `--ad-account` IDs are distinct from legacy v5 `--org` IDs. Discover each; never substitute one for the other.
- Ads credentials are separate from App Store Connect credentials. Keep the Apple Account, ad account, legacy organization/campaign group,
  App Store Connect account, promoted app, API user, and OAuth client distinct. Request read-only access for reporting unless approved work needs
  writes; never persist access tokens.
- Keep AdServices attribution separate from campaign reporting and preserve platform attribution definitions. Repair Ads roles or the App Store
  Connect link as needed; pause for admin actions, verification, terms, or billing.

## Meta Ads

- Confirm the account name and ID in [Meta Ads Manager](https://www.facebook.com/ads/manager).
- Prefer the Marketing API when `$SERVICE_CREDENTIALS_HOME/meta-ads/system-user.json` exists; verify by listing ad accounts with only needed fields.
  Keep app, business portfolio, system user, account, scopes, and API version distinct.
- Repair business portfolio/account roles; never request another person's login.

## Snapchat Ads

- Confirm organization and ad account names/IDs in [Snapchat Ads Manager](https://ads.snapchat.com/).
- Prefer the Marketing API when `$SERVICE_CREDENTIALS_HOME/snapchat-ads/oauth.json` exists. Refresh through the official endpoint; verify by listing
  the user's organizations. Keep OAuth app, organization, and ad account distinct.
- Repair organization/account roles; never share another person's credentials.

## X Ads

- Use the Ads API (`https://ads-api.x.com/12`) when `$SERVICE_CREDENTIALS_HOME/x-ads/oauth.json` exists: OAuth 1.0a user context
  (HMAC-SHA1) with its consumer key/secret and access token/secret. Verify by listing `/accounts`.
- One login can manage several brands' ads accounts. The `handle` in `oauth.json` names only the login user, so list `/accounts` and each
  account's `promotable_users` before concluding a brand has no X account.
- `POST accounts/:id/tweet` with `as_user_id` and `nullcast=false` posts publicly as a promotable user the login can compose for
  (`authenticated_user_access` shows `TWEET_COMPOSER`). It cannot reply, so a thread needs that user's own OAuth token.
- Ads API IDs are base36 and differ from the numeric IDs in Ads Manager URLs; list campaigns and line items (ad groups) to map them. Budgets
  usually live on the line item, in local micros.
- Access is granted per developer app through X's Ads API access form; regenerating keys in the developer console invalidates the stored
  ones, so update the file in the same step.

## TikTok Ads

- Separate Marketing API credentials in `$SERVICE_CREDENTIALS_HOME/tiktok-ads/oauth.json` from Pixel Events API credentials in
  `tiktok-ads/events-api.json`.
- Use the Marketing API only with app approval, its ID/secret, and advertiser authorization; report access as pending until then. List authorized
  advertisers and confirm the target. Keep developer profile, app, Business Center, advertiser, and token distinct.
- Choose Direct Advertiser for the owner's account, Technology Company for third parties. Repair Business Center access without sharing logins.
