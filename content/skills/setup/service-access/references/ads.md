# Advertising platforms

Use the user's signed-in Chrome session to identify the intended account. Keep browser authentication in Chrome; never inspect or export cookies,
session storage, passwords, or tokens. Pause for login, OAuth, 2FA, CAPTCHA, or missing permissions. Get approval before changing ads, billing,
tracking, or account access.

## Google Ads

- Open [Google Ads](https://ads.google.com/) and confirm the selected customer or manager account by name and ID.
- If `$SERVICE_CREDENTIALS_HOME/secrets.zsh` contains `GOOGLE_ADS_*` credentials, prefer the configured API. Verify it by listing accessible
  customers. Keep the customer, manager, Cloud project, OAuth user and app, and developer-token owner distinct; choose `login-customer-id` for the
  task.
- Repair API access through its developer token, enabled API, and OAuth client, then update `secrets.zsh`.

## Apple Ads

- Open [Apple Ads Advanced](https://app-ads.apple.com/cm/app/) and confirm the organization, campaign group, currency, timezone, and user role.
- When `$SERVICE_CREDENTIALS_HOME/apple-ads/oauth.json` and its private key exist, prefer the Campaign Management API. Use the current official API
  guidance to verify access. Request a Read Only API role for reporting unless approved work needs write access.
- Keep the Apple Account, Ads organization, campaign group, App Store Connect account, promoted app, API user, OAuth client, and AdServices
  attribution integration distinct. Store client, team, key, and optional organization IDs with the private-key path. Create access tokens at runtime;
  never persist them.
- Treat campaign reporting and AdServices attribution as separate routes. Preserve each platform's attribution definitions. If access is missing,
  repair the Ads role or App Store Connect link. Pause for account-admin actions, account verification, terms, or billing.

## Meta Ads

- Open [Meta Ads Manager](https://www.facebook.com/ads/manager) and confirm the ad account name and ID.
- If `$SERVICE_CREDENTIALS_HOME/meta-ads/system-user.json` exists, prefer the Marketing API. Verify access by listing ad accounts with only the needed
  fields. Keep the app, business portfolio, system user, account, scopes, and API version distinct.
- Repair missing access through the owning business portfolio or account roles. Never request another person's login.

## Snapchat Ads

- Open [Snapchat Ads Manager](https://ads.snapchat.com/) and confirm the organization and ad account by name and ID.
- If `$SERVICE_CREDENTIALS_HOME/snapchat-ads/oauth.json` exists, prefer the Marketing API. Refresh tokens through the official endpoint when needed
  and verify access by listing the user's organizations. Keep the OAuth app, organization, and ad account distinct.
- Repair missing access through organization or account roles, without sharing another person's credentials.

## TikTok Ads

- Keep Marketing API credentials in `$SERVICE_CREDENTIALS_HOME/tiktok-ads/oauth.json` separate from Pixel Events API credentials in
  `tiktok-ads/events-api.json`.
- Use the Marketing API only with an approved app and advertiser authorization. List authorized advertisers, then confirm the intended advertiser.
  Keep the developer profile, app, Business Center, advertiser, and token distinct. Report API access as pending until the app is approved and its ID
  and secret are available.
- Use Direct Advertiser for an app managing its owner's account; use Technology Company for third-party advertisers. Repair missing account access
  through Business Center without sharing another person's credentials.
