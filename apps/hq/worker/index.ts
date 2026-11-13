// The Housekeeper HQ Worker. Cloudflare Access guards hq.harium.app; static assets serve the site, and /api reads the data
// keepers push to R2 and saves the owner's picks. Every /api request must carry a valid Access token for the HQ application,
// so the API stays private even if the Worker were reached some other way.
import {
  Answer, AnswerInput, HQ_HOST, Question, REPORT_TYPES, Status, pageKey, pagePickKey, questionKey, type Page, type ReportType,
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

async function questions(env: Env): Promise<Question[]> {
  const keys = await listKeys(env, "questions/");
  return (await Promise.all(keys.map((key) => readJson<Question>(env, key)))).filter((q): q is Question => !!q);
}

/** Status items and thread questions with the owner's pending picks, so a pick shows as sent until it is applied. */
async function status(env: Env) {
  const [saved, asked] = await Promise.all([readJson<Status>(env, "status.json"), questions(env)]);
  const items = [...(saved?.items ?? []), ...asked];
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

  // Thread questions: any thread posts, updates, and drops its own; main-mac's `hq deliver` reads them with their picks.
  if (route === "questions") {
    const id = type;
    if (request.method === "GET" && !id) {
      const [asked, keys] = await Promise.all([questions(env), listKeys(env, "answers/")]);
      const answers = await Promise.all(keys.map((key) => readJson<Answer>(env, key)));
      const byId = new Map(answers.filter((a): a is Answer => !!a).map((a) => [a.id, a]));
      return json({ questions: asked.map((question) => ({ question, answer: byId.get(question.id) ?? null })) });
    }
    if (request.method === "PUT" && id) {
      const parsed = Question.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return fail(400, parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
      if (parsed.data.id !== id) return fail(400, "id does not match the path");
      const old = await readJson<Question>(env, questionKey(id));
      const question = { ...parsed.data, createdAt: old?.createdAt ?? parsed.data.createdAt, updatedAt: new Date().toISOString() };
      await env.DATA.put(questionKey(id), JSON.stringify(question), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, question });
    }
    // `hq deliver` clears a note-only answer it passed on, leaving the question open.
    if (request.method === "DELETE" && id && date === "answer") {
      await env.DATA.delete(answerKey(id));
      return json({ ok: true });
    }
    if (request.method === "DELETE" && id) {
      // A page question keeps its pick, so the page still shows what Muhammed chose after the item closes.
      const [question, answer] = await Promise.all([readJson<Question>(env, questionKey(id)), readJson<Answer>(env, answerKey(id))]);
      if (answer?.choice && question?.report?.startsWith(`https://${HQ_HOST}/p/`))
        await env.DATA.put(pagePickKey(id), JSON.stringify(answer), { httpMetadata: { contentType: "application/json" } });
      await Promise.all([env.DATA.delete(questionKey(id)), env.DATA.delete(answerKey(id))]);
      return json({ ok: true });
    }
  }

  // A page with the state of each of its questions: open, the pick waiting for delivery, or the pick already delivered.
  if (request.method === "GET" && route === "pages" && type) {
    if (!/^[a-z0-9-]+$/.test(type)) return fail(404, "no such page");
    const page = await readJson<Page>(env, pageKey(type));
    if (!page) return fail(404, "no such page");
    const ids = page.blocks.flatMap((b) => (b.type === "options" && b.question ? [b.question] : []));
    const picks = Object.fromEntries(
      await Promise.all(
        ids.map(async (id) => {
          const [open, answer, kept] = await Promise.all([
            env.DATA.head(questionKey(id)),
            readJson<Answer>(env, answerKey(id)),
            readJson<Answer>(env, pagePickKey(id)),
          ]);
          return [id, { open: !!open, answer: answer ?? kept ?? null }] as const;
        }),
      ),
    );
    return json({ page, picks });
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
