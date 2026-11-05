import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CREDENTIALS_HOME_ENV, CREDENTIALS_ROOT } from "../../config/credentials";

// share-html pages sit behind Cloudflare Access. Muhammed signs in; agents present this Access service token, which
// the "Shared HTML" Access application accepts through a Service Auth policy. The R2 custom domain serves reads only.
export const SHARE_ACCESS_FILE = "cloudflare/share-html-access.json";
export const EXPIRY_WARNING_DAYS = 30;

export interface ShareAccess {
  client_id: string;
  client_secret: string;
  expires_at?: string;
}

export function shareAccessPath(env = process.env, home = homedir()): string {
  return join(env[CREDENTIALS_HOME_ENV] || join(home, CREDENTIALS_ROOT), SHARE_ACCESS_FILE);
}

export function readShareAccess(path = shareAccessPath()): ShareAccess {
  let access: Partial<ShareAccess>;
  try {
    access = JSON.parse(readFileSync(path, "utf8")) as Partial<ShareAccess>;
  } catch {
    throw new Error(
      `${path} is missing or unreadable; main-mac's mise run install copies it to the spare Macs`,
    );
  }
  if (!access.client_id || !access.client_secret)
    throw new Error(`${path} has no client_id or client_secret`);
  return access as ShareAccess;
}

export const accessHeaders = (access: ShareAccess) => ({
  "CF-Access-Client-Id": access.client_id,
  "CF-Access-Client-Secret": access.client_secret,
});

/** A redirect to the Access sign-in, or a 401/403, means the request did not get past Access. */
export function isAccessDenied(response: Response): boolean {
  const location = response.headers.get("location") ?? "";
  return (
    response.status === 401 || response.status === 403 || location.includes("cloudflareaccess.com")
  );
}

/** Why agents cannot read share-html pages, for doctor; undefined when they can. */
export async function shareAccessProblem(
  host: string,
  path = shareAccessPath(),
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<string | undefined> {
  let access: ShareAccess;
  try {
    access = readShareAccess(path);
  } catch (error) {
    return (error as Error).message;
  }

  const response = await fetcher(`https://${host}/`, {
    method: "HEAD",
    redirect: "manual",
    headers: accessHeaders(access),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: Error) => error);
  if (response instanceof Error) return `cannot reach ${host}: ${response.message}`;
  if (isAccessDenied(response))
    return `Cloudflare Access rejected the service token in ${path} (HTTP ${response.status})`;

  const expiry = access.expires_at ? Date.parse(access.expires_at) : NaN;
  const daysLeft = (expiry - now) / 86_400_000;
  if (daysLeft < EXPIRY_WARNING_DAYS)
    return `the service token in ${path} expires ${access.expires_at}; extend it with cf zero-trust access service-tokens refresh and copy the new expires_at there`;
  return undefined;
}
