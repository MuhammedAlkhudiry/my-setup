export const CREDENTIALS_HOME_ENV = "SERVICE_CREDENTIALS_HOME";

export const CREDENTIALS_ROOT = ".config/my-setup/credentials";

export const CREDENTIAL_FILES = [
  "secrets.zsh",
  "google-play/service-account.json",
  "app-store-connect/AuthKey_2FG8Y954VK.p8",
  "environments/awraq/mobile-release.env",
  "cloudflare/share-html-access.json",
] as const;

// Credentials main-mac copies to the spare Macs on every install. Production access never leaves main-mac.
export const SPARE_MAC_CREDENTIAL_FILES = ["cloudflare/share-html-access.json"] as const;
