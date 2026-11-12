// The Housekeeper HQ Worker. Cloudflare Access guards hq.harium.app; static assets serve the site, and /api reads the data
// keepers push to R2 and saves the owner's picks. Every /api request must carry a valid Access token for the HQ application,
// so the API stays private even if the Worker were reached some other way.
import { Answer, AnswerInput, REPORT_TYPES, Status, type ReportType } from "../contract";

interface Env {
  DATA: R2Bucket;
  ASSETS: Fetcher;
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
  // The Housekeeper's T3 wake-up webhook; a secret, never sent to the browser.
  NOTIFY_URL?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const fail = (status: number, error: string) => json({ error }, status);

// ---- Access token check ----------------------------------------------------------------------------------------------

type Jwk = JsonWebKey & { kid: string };
let certs: { keys: Jwk[]; at: number } | undefined;

const b64 = (part: string) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function accessEmail(request: Request, env: Env): Promise<string | undefined> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return undefined;
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature) return undefined;

  const { kid, alg } = JSON.parse(new TextDecoder().decode(b64(head)));
  if (alg !== "RS256") return undefined;
  if (!certs || Date.now() - certs.at > 3_600_000 || !certs.keys.some((k) => k.kid === kid)) {
    const response = await fetch(`https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`);
    certs = { keys: ((await response.json()) as { keys: Jwk[] }).keys, at: Date.now() };
  }
  const jwk = certs.keys.find((k) => k.kid === kid);
  if (!jwk) return undefined;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(signature), new TextEncoder().encode(`${head}.${body}`));
  if (!valid) return undefined;

  const claims = JSON.parse(new TextDecoder().decode(b64(body)));
  const audiences: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(env.ACCESS_AUD) || claims.exp * 1000 < Date.now()) return undefined;
  // Service tokens carry no email; they may read, and the owner's email marks who answered.
  return claims.email ?? `service:${claims.common_name ?? "token"}`;
}

// ---- data ------------------------------------------------------------------------------------------------------------

const answerKey = (id: string) => `answers/${encodeURIComponent(id)}.json`;

async function readJson<T>(env: Env, key: string): Promise<T | undefined> {
  const object = await env.DATA.get(key);
  return object ? ((await object.json()) as T) : undefined;
}

async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DATA.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Status items with the owner's pending picks, so a pick shows as sent until the Housekeeper applies it. */
async function status(env: Env) {
  const saved = await readJson<Status>(env, "status.json");
  if (!saved) return { updatedAt: null, items: [], answers: {} };
  const keys = await listKeys(env, "answers/");
  const all = await Promise.all(keys.map((key) => readJson<Answer>(env, key)));
  const byId = new Map(saved.items.map((item) => [item.id, item]));
  const answers: Record<string, Answer> = {};
  for (const answer of all) {
    const item = answer && byId.get(answer.id);
    if (item && (!item.appliedAt || answer.at > item.appliedAt)) answers[answer.id] = answer;
  }
  return { ...saved, answers };
}

async function reportDates(env: Env, type: ReportType) {
  const keys = await listKeys(env, `reports/${type}/`);
  return keys.map((key) => key.slice(key.lastIndexOf("/") + 1, -".json".length)).sort().reverse();
}

async function notify(env: Env) {
  if (!env.NOTIFY_URL) return fail(503, "notify is not configured");
  const keys = await listKeys(env, "answers/");
  const response = await fetch(env.NOTIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      note: `Muhammed sent picks on hq.harium.app (${keys.length} saved). Read them with \`hq answers --json\`.`,
    }),
  });
  return response.ok ? json({ ok: true }) : fail(502, `notify failed: ${response.status}`);
}

// ---- routes ----------------------------------------------------------------------------------------------------------

async function api(request: Request, env: Env, path: string[]): Promise<Response> {
  const by = await accessEmail(request, env);
  if (!by) return fail(401, "sign in through Cloudflare Access");
  const [route, type, date] = path;

  if (request.method === "GET" && route === "status") return json(await status(env));

  if (request.method === "GET" && route === "reports") {
    if (!REPORT_TYPES.includes(type as ReportType)) return fail(404, "unknown report type");
    const dates = await reportDates(env, type as ReportType);
    if (!date) return json({ dates });
    const day = date === "latest" ? dates[0] : date;
    const report = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? await readJson(env, `reports/${type}/${day}.json`) : undefined;
    return report ? json({ report, dates }) : fail(404, "no report for that day");
  }

  if (request.method === "POST" && route === "answers") {
    if (by.startsWith("service:")) return fail(403, "only the owner answers");
    const parsed = AnswerInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail(400, parsed.error.issues.map((i) => i.message).join("; "));
    const { id, choice, note } = parsed.data;
    if (!choice && !note.trim()) {
      await env.DATA.delete(answerKey(id));
      return json({ ok: true, cleared: true });
    }
    const answer: Answer = { id, choice, note, at: new Date().toISOString(), by };
    await env.DATA.put(answerKey(id), JSON.stringify(answer), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, answer });
  }

  if (request.method === "POST" && route === "notify") {
    if (by.startsWith("service:")) return fail(403, "only the owner notifies");
    return notify(env);
  }

  return fail(404, "not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, url.pathname.slice(5).split("/").filter(Boolean));
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
