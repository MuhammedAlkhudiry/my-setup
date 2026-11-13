#!/usr/bin/env bun
// hq: write data to the Housekeeper HQ site (hq.harium.app) and read the owner's picks back. Keepers only write data;
// the site renders it. See apps/hq/contract for the shapes.

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cac } from "cac";
import { execa } from "execa";

import {
  Answer,
  HOSTS,
  HQ_HOST,
  PROJECTS,
  Page,
  Question,
  Report,
  Status,
  type Host,
  type Project,
  type StatusItem,
  type ThreadRef,
  pageKey,
  pageUrl,
  reportKey,
  reportUrl,
} from "../../apps/hq/contract";
import { agentOutput, parseCli } from "../lib/agent-output";
import { runCf } from "../lib/cf-auth";
import { accessHeaders, readShareAccess } from "../lib/share-access";

export const HQ_BUCKET = "housekeeper-hq";
const APP_DIR = resolve(import.meta.dir, "../../apps/hq");
const HOUSEKEEPER = join(homedir(), ".local", "state", "housekeeper");
const json = process.argv.includes("--json");

agentOutput("hq", {
  nativeJson: true,
  summary: (output) => output.trim().split("\n")[0] || "hq: ok",
});

async function put(key: string, body: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hq-"));
  const file = join(dir, "body.json");
  try {
    await writeFile(file, body);
    await runCf([
      "r2",
      "objects",
      "put",
      key,
      "--bucket-name",
      HQ_BUCKET,
      "--file",
      file,
      "--content-type",
      "application/json",
      "--quiet",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function listKeys(prefix: string): Promise<string[]> {
  const { stdout } = await runCf([
    "r2",
    "objects",
    "list",
    "--bucket-name",
    HQ_BUCKET,
    "--prefix",
    prefix,
    "--per-page",
    "1000",
  ]);
  return (JSON.parse(stdout) as { key: string }[]).map((object) => object.key);
}

async function get(key: string): Promise<string> {
  return (await runCf(["r2", "objects", "get", key, "--bucket-name", HQ_BUCKET])).stdout;
}

/** An object that may be gone, such as an answer `hq deliver` deleted after it was listed. */
async function getIfPresent(key: string): Promise<string | undefined> {
  const result = await runCf(["r2", "objects", "get", key, "--bucket-name", HQ_BUCKET], {
    reject: false,
  });
  if (!result.failed) return result.stdout;
  if (/does not exist|\b404\b/i.test(`${result.stderr}\n${result.stdout}`)) return undefined;
  throw result;
}

const print = (line: string, data: Record<string, unknown>) =>
  console.log(json ? JSON.stringify({ ok: true, ...data }) : line);

// ---- status ----------------------------------------------------------------------------------------------------------

type StateItem = Record<string, unknown> & {
  id: string;
  group: string;
  status: string;
  project?: string;
  owner?: string | null;
  snoozedUntil?: string;
  report?: string;
  createdAt: string;
  updatedAt?: string;
};

/** The state's free-text project, such as "Awraq + Harium" or "Mac", as the site's projects. */
export function projectsOf(project = ""): Project[] {
  const text = project.toLowerCase();
  const found = PROJECTS.filter((p) => p !== "setup" && text.includes(p));
  if (found.length) return found;
  if (/\b(both|ads|product|finance)\b/.test(text)) return ["awraq", "harium"];
  return ["setup"];
}

const hqRoute = (url?: string) =>
  url?.startsWith(`https://${HQ_HOST}/#/`) ? url.slice(`https://${HQ_HOST}/`.length) : url;
const iso = (value: string) => new Date(value).toISOString();

/** The site's status.json from the Housekeeper's state: open items only, without progress or snoozed items. */
export function statusFromState(pending: StateItem[], now = new Date()): Status {
  const items: StatusItem[] = pending
    .filter((item) => item.status === "open" && item.group !== "In progress")
    .filter((item) => !(item.snoozedUntil && Date.parse(item.snoozedUntil) > now.getTime()))
    .map((item) => ({
      id: item.id,
      group: item.group as StatusItem["group"],
      projects: projectsOf(item.project),
      owner: (item.owner || "housekeeper") as StatusItem["owner"],
      title: String(item.title ?? ""),
      detail: (item.detail as string) || undefined,
      options: item.options as StatusItem["options"],
      links: ((item.links as StatusItem["links"]) ?? []).map((link) => ({
        ...link,
        url: hqRoute(link.url)!,
      })),
      report: hqRoute(item.report),
      rating: item.rating as StatusItem["rating"],
      next: (item.next as string) || undefined,
      letters: (item.letters as string[]) ?? [],
      createdAt: iso(item.createdAt),
      updatedAt: iso(item.updatedAt ?? item.createdAt),
      appliedAt: item.appliedAt ? iso(item.appliedAt as string) : undefined,
    }));
  return Status.parse({ updatedAt: now.toISOString(), items });
}

async function pushStatus(options: { state?: string; dryRun?: boolean }): Promise<void> {
  const path = options.state ?? join(HOUSEKEEPER, "state.json");
  const state = (await Bun.file(path).json()) as { pending?: StateItem[] };
  const status = statusFromState(state.pending ?? []);
  if (options.dryRun)
    return print(`hq: status valid, ${status.items.length} items`, { items: status.items.length });
  await put("status.json", JSON.stringify(status));
  print(`hq: status pushed, ${status.items.length} items; https://${HQ_HOST}/`, {
    url: `https://${HQ_HOST}/`,
    items: status.items.length,
  });
}

// ---- reports ---------------------------------------------------------------------------------------------------------

async function pushReport(file: string, options: { dryRun?: boolean }): Promise<void> {
  const parsed = Report.safeParse(await Bun.file(file).json());
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`hq: ${file} does not match the report contract\n${lines.join("\n")}`);
  }
  const report = parsed.data;
  const url = reportUrl(report.type, report.date);
  if (!options.dryRun) await put(reportKey(report.type, report.date), JSON.stringify(report));
  print(`hq: ${report.type} ${report.date} ${options.dryRun ? "valid" : "pushed"}; ${url}`, {
    url,
    type: report.type,
    date: report.date,
  });
}

/** Projects named by GitHub links to their repositories, such as a PR in `--context`. */
export function projectsFromUrls(text: string): Project[] {
  const found = new Set<Project>();
  for (const [, repo] of text.matchAll(/github\.com\/[\w.-]+\/([\w.-]+)/gi)) {
    const name = repo.toLowerCase();
    if (name === "my-setup") found.add("setup");
    for (const p of PROJECTS) if (p !== "setup" && name.startsWith(p)) found.add(p);
  }
  return [...found];
}

// ---- pages: one-off reports and option pages at /p/<slug> --------------------------------------------------------------

type PagePicks = { page: Page; picks: Record<string, { open: boolean; answer: Answer | null }> };

/** Pushes a page; each options block becomes this thread's lettered question, kept by block id across pushes. */
async function pushPage(file: string, options: { dryRun?: boolean }): Promise<void> {
  const parsed = Page.safeParse(await Bun.file(file).json());
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`hq: ${file} does not match the page contract\n${lines.join("\n")}`);
  }
  const page = parsed.data;
  const url = pageUrl(page.slug);
  const asks = page.blocks.filter((b) => b.type === "options");
  if (options.dryRun) return print(`hq: page ${page.slug} valid; ${url}`, { url, slug: page.slug });

  const before = await hqApi<PagePicks>("GET", `pages/${page.slug}`).catch((error: Error) => {
    if (/\(404\)/.test(error.message)) return undefined;
    throw error;
  });
  const now = new Date().toISOString();
  page.thread =
    process.env.T3CODE_THREAD_ID || asks.length ? await thisThread() : before?.page.thread;
  page.createdAt = before?.page.createdAt ?? now;
  page.updatedAt = now;

  for (const block of asks) {
    const prev = before?.page.blocks.find((b) => b.type === "options" && b.id === block.id);
    const kept = prev?.type === "options" ? prev : undefined;
    const letter = kept?.letter ?? (await reserveLetter());
    block.letter = letter;
    block.question =
      kept?.question ?? `q-${letter.toLowerCase()}-${page.slug}-${block.id}`.slice(0, 200);
    block.options.forEach((option, index) => (option.key = `${letter}${index + 1}`));

    // A question Muhammed already answered and the thread received stays closed; its pick shows on the page.
    const pick = before?.picks[block.question];
    if (pick && !pick.open && pick.answer?.choice) continue;
    const question = Question.parse({
      id: block.question,
      group: "Needs you",
      projects: page.projects,
      owner: "housekeeper",
      title: block.title,
      detail: block.context ?? page.description ?? page.title,
      options: block.options.map(({ key, label, tradeoff, recommended }) => ({
        key,
        label,
        tradeoff,
        recommended,
      })),
      report: url,
      letters: [letter],
      thread: page.thread,
      createdAt: before?.page.createdAt ?? now,
      updatedAt: now,
    });
    await hqApi("PUT", `questions/${encodeURIComponent(question.id)}`, question);
  }

  await put(pageKey(page.slug), JSON.stringify(Page.parse(page)));
  const letters = asks.map((b) => b.letter!);
  print(`hq: page ${url}${letters.length ? ` (asks ${letters.join(" ")})` : ""}`, {
    url,
    slug: page.slug,
    letters,
    keys: Object.fromEntries(asks.map((b) => [b.letter, b.options.map((o) => o.key)])),
  });
}

// ---- answers ---------------------------------------------------------------------------------------------------------

/** The owner's saved picks, in the `{state: {id: {choice, note, at}}}` shape `share-html feedback --json` printed. */
async function answers(): Promise<void> {
  const keys = await listKeys("answers/");
  // An answer deleted between the listing and the read is no answer yet.
  const bodies = await Promise.all(keys.map(getIfPresent));
  const saved = bodies.flatMap((body) => (body ? [Answer.parse(JSON.parse(body))] : []));
  const state = Object.fromEntries(
    saved.map(({ id, choice, note, at }) => [id, { choice, note, at }]),
  );
  if (json) console.log(JSON.stringify({ url: `https://${HQ_HOST}/`, state }));
  else if (!saved.length) console.log("hq: no saved picks");
  else for (const a of saved) console.log(`${a.id} ${a.choice || "-"} ${a.note}`.trimEnd());
}

// ---- thread questions -----------------------------------------------------------------------------------------------
// Any thread on main-mac, small-mac, or big-mac asks Muhammed through hq: the question shows in Needs you under its thread,
// and main-mac's `hq deliver` sends the pick straight back to that thread and closes the item.

type Asked = { question: Question; answer: Answer | null };
const T3 = join(homedir(), ".t3", "bin", "t3");
// A pick waits this long before delivery, so Muhammed can still undo it on the page.
const UNDO_GRACE_MS = 15_000;

async function hqApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://${HQ_HOST}/api/${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...accessHeaders(readShareAccess()),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok)
    throw new Error(
      `hq: ${method} /api/${path} failed (${response.status}): ${data?.error ?? "not past Cloudflare Access"}`,
    );
  return data as T;
}

function thisHost(): Host {
  const name = (
    Bun.spawnSync(["scutil", "--get", "LocalHostName"]).stdout.toString().trim() || hostname()
  ).toLowerCase();
  const host = HOSTS.find((h) => name.startsWith(h));
  if (!host) throw new Error(`hq: ${name} is not main-mac, small-mac, or big-mac`);
  return host;
}

/** The calling thread, from T3's environment and its own record of the thread. */
async function thisThread(): Promise<ThreadRef> {
  const id = process.env.T3CODE_THREAD_ID;
  if (!id) throw new Error("hq: T3CODE_THREAD_ID is unset; run `hq ask` from a T3 thread");
  const { stdout } = await execa(T3, ["thread", "show", id, "--json"]);
  const { thread } = JSON.parse(stdout) as { thread: { title?: string; link: string } };
  return {
    id,
    host: thisHost(),
    title: (thread.title || "Untitled thread").slice(0, 120),
    link: thread.link,
  };
}

/** The next letter of the one shared sequence, which the Housekeeper's `hk letters` keeps on main-mac. */
async function reserveLetter(): Promise<string> {
  const hk = join(homedir(), ".local", "bin", "hk");
  const { stdout } = existsSync(hk)
    ? await execa(hk, ["letters", "1"])
    : await execa("ssh", ["main-mac-inbox", "letters"]);
  const letter = stdout.trim();
  if (!/^[A-Z]$/.test(letter)) throw new Error(`hq: could not reserve a letter: ${stdout}`);
  return letter;
}

const asList = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "question";

async function mine(thread = process.env.T3CODE_THREAD_ID): Promise<Asked[]> {
  const { questions } = await hqApi<{ questions: Asked[] }>("GET", "questions");
  return questions.filter(({ question }) => question.thread.id === thread);
}

type AskOptions = {
  title?: string;
  context?: string;
  option?: unknown;
  link?: unknown;
  report?: string;
  project?: unknown;
  letter?: string;
};

async function ask(options: AskOptions): Promise<void> {
  if (!options.title || !options.context)
    throw new Error("hq ask: --title and --context are required");
  const labels = asList(options.option);
  if (labels.length < 2)
    throw new Error(
      "hq ask: give at least two --option values, the last one leaving today's behavior (Skip)",
    );
  const thread = await thisThread();
  const links = asList(options.link);
  const named = asList(options.project);

  const existing = options.letter
    ? (await mine(thread.id)).find(
        ({ question }) => question.letters[0] === options.letter!.toUpperCase(),
      )
    : undefined;
  if (options.letter && !existing)
    throw new Error(`hq ask: this thread has no open question ${options.letter.toUpperCase()}`);
  const projects = named.length
    ? named
    : (existing?.question.projects ??
      projectsFromUrls([options.context, options.report, ...links].join(" ")));
  if (!projects.length)
    throw new Error(
      "hq ask: give --project awraq, harium, or setup, or put the PR link in --context or --link",
    );
  const letter = existing?.question.letters[0] ?? (await reserveLetter());

  const now = new Date().toISOString();
  const question = Question.parse({
    id:
      existing?.question.id ??
      `q-${letter.toLowerCase()}-${slug(options.title)}-${Date.now().toString(36)}`,
    group: "Needs you",
    projects,
    owner: "housekeeper",
    title: options.title,
    detail: options.context,
    options: labels.map((value, index) => {
      const [label, tradeoff, rec] = value.split("|").map((part) => part.trim());
      return {
        key: `${letter}${index + 1}`,
        label,
        tradeoff: tradeoff || undefined,
        recommended: rec === "rec" || undefined,
      };
    }),
    links: links.map((value) => {
      const at = value.lastIndexOf("|");
      return { label: value.slice(0, at).trim(), url: value.slice(at + 1).trim() };
    }),
    report: options.report,
    letters: [letter],
    thread,
    createdAt: existing?.question.createdAt ?? now,
    updatedAt: now,
  });
  await hqApi("PUT", `questions/${encodeURIComponent(question.id)}`, question);
  const keys = question.options.map((o) => o.key).join(" ");
  print(`hq: ${existing ? "updated" : "asked"} ${letter} (${keys}); https://${HQ_HOST}/`, {
    letter,
    id: question.id,
    keys: question.options.map((o) => o.key),
    url: `https://${HQ_HOST}/`,
  });
}

async function drop(ref: string): Promise<void> {
  const found = (await mine()).find(
    ({ question }) => question.id === ref || question.letters[0] === ref.toUpperCase(),
  );
  if (!found) throw new Error(`hq drop: this thread has no open question ${ref}`);
  await hqApi("DELETE", `questions/${encodeURIComponent(found.question.id)}`);
  print(`hq: dropped ${found.question.letters[0]}`, {
    letter: found.question.letters[0],
    id: found.question.id,
  });
}

async function listQuestions(options: { all?: boolean }): Promise<void> {
  const list = options.all
    ? (await hqApi<{ questions: Asked[] }>("GET", "questions")).questions
    : await mine();
  if (json)
    return console.log(JSON.stringify({ ok: true, url: `https://${HQ_HOST}/`, questions: list }));
  if (!list.length) return console.log("hq: no open questions");
  for (const { question, answer } of list)
    console.log(
      `${question.letters[0]}\t${answer ? `picked ${answer.choice || "note"}` : "waiting"}\t${question.thread.title}\t${question.title}`,
    );
}

/** What the asking thread reads when Muhammed answers on hq. */
export function pickMessage(question: Question, answer: Answer): string {
  const letter = question.letters[0];
  const keys = answer.choice.split(" ").filter(Boolean);
  const named = keys.map((key) => {
    const option = question.options.find((o) => o.key === key);
    return option ? `${option.key} (${option.label})` : key;
  });
  const note = answer.note.trim() ? ` His note: "${answer.note.trim()}"` : "";
  if (!answer.choice)
    return `Muhammed added a note to question ${letter} ("${question.title}") on hq; it stays open there.${note}`;
  const pick = named.join(" + ");
  return `Muhammed answered question ${letter} ("${question.title}") on hq: ${pick}.${note} hq closed the item; act on the pick.`;
}

async function sendToThread(thread: ThreadRef, message: string): Promise<void> {
  if (thread.host === thisHost())
    await execa(T3, ["thread", "send", thread.id, "-"], { input: message });
  else
    await execa(
      "ssh",
      ["-o", "BatchMode=yes", thread.host, `$HOME/.t3/bin/t3 thread send ${thread.id} -`],
      { input: message },
    );
}

/** main-mac, every half minute: send each settled pick to its thread, close the item, and record the letters still open. */
async function deliver(): Promise<void> {
  const { questions } = await hqApi<{ questions: Asked[] }>("GET", "questions");
  const open = new Set<string>();
  const sent: string[] = [];
  const failed: string[] = [];

  for (const { question, answer } of questions) {
    const letter = question.letters[0];
    open.add(letter);
    if (!answer || Date.now() - Date.parse(answer.at) < UNDO_GRACE_MS) continue;
    try {
      await sendToThread(question.thread, pickMessage(question, answer));
      await hqApi(
        "DELETE",
        `questions/${encodeURIComponent(question.id)}${answer.choice ? "" : "/answer"}`,
      );
      if (answer.choice) open.delete(letter);
      sent.push(letter);
    } catch (error) {
      failed.push(
        `${letter} → ${question.thread.title}: ${(error as Error).message.split("\n")[0]}`,
      );
    }
  }

  await writeFile(join(HOUSEKEEPER, "hq-letters.json"), JSON.stringify([...open]));
  if (failed.length) throw new Error(`hq deliver: ${failed.length} failed\n${failed.join("\n")}`);
  // Quiet when nothing moved, since launchd runs this every half minute into one log.
  if (sent.length || json)
    print(`hq: delivered ${sent.join(" ")}, ${open.size} open`, {
      delivered: sent,
      open: [...open],
    });
}

// ---- deploy ----------------------------------------------------------------------------------------------------------

// `cf deploy` in apps/hq builds the site and the Worker with Vite and uploads both (see apps/hq/cloudflare.config.ts).
async function deploy(options: { dryRun?: boolean }): Promise<void> {
  const secretsDir = await mkdtemp(join(tmpdir(), "hq-deploy-"));
  try {
    await execa("bun", ["install", "--frozen-lockfile"], { cwd: APP_DIR });
    // The Worker wakes the Housekeeper thread through its T3 webhook when the owner sends picks.
    const notify = (
      await Bun.file(join(HOUSEKEEPER, "notify-webhook-url"))
        .text()
        .catch(() => "")
    ).trim();
    const secretsFile = join(secretsDir, "secrets.json");
    await writeFile(secretsFile, JSON.stringify(notify ? { NOTIFY_URL: notify } : {}), {
      mode: 0o600,
    });
    const args = [
      "deploy",
      "--secrets-file",
      secretsFile,
      ...(options.dryRun ? ["--dry-run"] : []),
    ];
    const result = await execa("node", [join(APP_DIR, "node_modules/cf/bin/cf"), ...args], {
      cwd: APP_DIR,
      reject: false,
      all: true,
    });
    if (result.exitCode !== 0) throw new Error(`hq: cf deploy failed\n${result.all}`);
    print(`hq: ${options.dryRun ? "dry run passed" : "deployed"}; https://${HQ_HOST}/`, {
      url: `https://${HQ_HOST}/`,
    });
  } finally {
    await rm(secretsDir, { recursive: true, force: true });
  }
}

// ---- cli -------------------------------------------------------------------------------------------------------------

async function run(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  const cli = cac("hq");
  cli
    .command(
      "push <what> [file]",
      "Push `status` (from the Housekeeper's state.json), `report <file.json>`, or `page <file.json>` to the site",
    )
    .option("--state <path>", "State file for `push status`, defaults to the Housekeeper's")
    .option("--dry-run", "Validate without uploading")
    .action((what: string, file: string | undefined, options) =>
      run(async () => {
        if (what === "status") return pushStatus(options);
        if (what === "report" && file) return pushReport(file, options);
        if (what === "page" && file) return pushPage(file, options);
        throw new Error(
          "hq: use `hq push status`, `hq push report <file.json>`, or `hq push page <file.json>`",
        );
      }),
    );
  cli.command("answers", "Print the owner's saved picks").action(() => run(answers));
  cli
    .command(
      "ask",
      "Post this thread's question to hq Needs you; prints its letter and option keys",
    )
    .option("--title <text>", "The question")
    .option("--context <text>", "One line on today's behavior, with an example")
    .option(
      "--option <label|tradeoff|rec>",
      "One option, in order; end with the Skip option (repeat)",
    )
    .option("--link <label|url>", "Something Muhammed needs open to decide (repeat)")
    .option("--report <url>", "The options page or report")
    .option(
      "--project <name>",
      "awraq, harium, or setup (repeat); required unless a GitHub repo link in --context or --link names it",
    )
    .option("--letter <A>", "Update this thread's open question with that letter instead")
    .action((options: AskOptions) => run(() => ask(options)));
  cli
    .command(
      "drop <letter>",
      "Close this thread's question, such as after Muhammed answers in chat",
    )
    .action((ref: string) => run(() => drop(ref)));
  cli
    .command("questions", "This thread's open questions and whether Muhammed picked")
    .option("--all", "Every thread's questions")
    .action((options) => run(() => listQuestions(options)));
  cli
    .command("deliver", "main-mac: send settled picks to their threads and close them")
    .action(() => run(deliver));
  cli
    .command("deploy", "Build and deploy the site and its Worker")
    .option("--dry-run", "Build and check without uploading")
    .action((options) => run(() => deploy(options)));
  cli.option("--json", "Emit structured results");
  cli.option("--verbose", "Print details");
  cli.help();
  parseCli(cli);
}
