// The Housekeeper HQ Worker. Cloudflare Access guards hq.harium.app; static assets serve the site, and /api reads the data
// keepers push to R2 and saves the owner's picks. Every /api request must carry a valid Access token for the HQ application,
// so the API stays private even if the Worker were reached some other way.
import {
  Answer, AnswerInput, PageSendInput, REPORT_TYPES, Status, pageKey, pagePickKey, pageSendKey, type Page, type PageSend, type ReportType,
} from "../contract";

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

/** Status items with the owner's pending picks, so a pick shows as sent until it is applied. */
async function status(env: Env) {
  const saved = await readJson<Status>(env, "status.json");
  const items = saved?.items ?? [];
  const keys = await listKeys(env, "answers/");
  const all = await Promise.all(keys.map((key) => readJson<Answer>(env, key)));
  const byId = new Map(items.map((item) => [item.id, item]));
  const answers: Record<string, Answer> = {};
  for (const answer of all) {
    const item = answer && byId.get(answer.id);
    if (item && (!item.appliedAt || answer.at > item.appliedAt)) answers[answer.id] = answer;
  }
  return { updatedAt: saved?.updatedAt ?? null, items, answers };
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

  if (route === "pages" && type && !/^[a-z0-9-]+$/.test(type)) return fail(404, "no such page");

  // A page with each options block's pick, sent or waiting for delivery.
  if (request.method === "GET" && route === "pages" && type) {
    const page = await readJson<Page>(env, pageKey(type));
    if (!page) return fail(404, "no such page");
    const ids = page.blocks.flatMap((b) => (b.type === "options" ? [b.id] : []));
    const [picks, pending] = await Promise.all([
      Promise.all(ids.map(async (id) => [id, (await readJson<Answer>(env, pagePickKey(type, id))) ?? null] as const)),
      env.DATA.head(pageSendKey(type)),
    ]);
    return json({ page, picks: Object.fromEntries(picks), delivering: !!pending });
  }

  // One Send: saves every block's pick and queues them as one message to the page's thread.
  if (request.method === "POST" && route === "pages" && type && date === "picks") {
    if (by.startsWith("service:")) return fail(403, "only the owner answers");
    const page = await readJson<Page>(env, pageKey(type));
    if (!page) return fail(404, "no such page");
    const parsed = PageSendInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail(400, parsed.error.issues.map((i) => i.message).join("; "));
    const blocks = new Set(page.blocks.flatMap((b) => (b.type === "options" ? [b.id] : [])));
    const at = new Date().toISOString();
    const picks: Record<string, Answer> = {};
    for (const [id, pick] of Object.entries(parsed.data.picks))
      if (blocks.has(id) && (pick.choice || pick.note.trim())) picks[id] = { id, ...pick, at, by };
    if (!Object.keys(picks).length) return fail(400, "nothing to send");
    const put = (key: string, body: unknown) => env.DATA.put(key, JSON.stringify(body), { httpMetadata: { contentType: "application/json" } });
    // Picks sent before an earlier send was delivered join it, so the thread still gets one message.
    const queued = await readJson<PageSend>(env, pageSendKey(type));
    await Promise.all([
      ...Object.values(picks).map((answer) => put(pagePickKey(type, answer.id), answer)),
      put(pageSendKey(type), { slug: type, picks: { ...queued?.picks, ...picks }, at } satisfies PageSend),
    ]);
    return json({ ok: true, picks });
  }

  // main-mac's `hq deliver` reads queued page sends and clears each once its thread has it.
  if (route === "page-sends") {
    if (request.method === "GET" && !type) {
      const sends = await Promise.all((await listKeys(env, "page-sends/")).map((key) => readJson<PageSend>(env, key)));
      const withPages = await Promise.all(
        sends.filter((s): s is PageSend => !!s).map(async (send) => ({ send, page: await readJson<Page>(env, pageKey(send.slug)) })),
      );
      return json({ sends: withPages });
    }
    if (request.method === "DELETE" && type && /^[a-z0-9-]+$/.test(type)) {
      // Only the send that was delivered; picks queued since then stay for the next run.
      const queued = await readJson<PageSend>(env, pageSendKey(type));
      if (queued && queued.at === new URL(request.url).searchParams.get("at")) await env.DATA.delete(pageSendKey(type));
      return json({ ok: true });
    }
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
