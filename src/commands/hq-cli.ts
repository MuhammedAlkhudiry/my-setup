#!/usr/bin/env bun
// hq: write data to the Housekeeper HQ site (hq.harium.app) and read the owner's picks back. Keepers only write data;
// the site renders it. See apps/hq/contract for the shapes.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cac } from "cac";
import { execa } from "execa";

import {
  Answer,
  HQ_HOST,
  PROJECTS,
  Report,
  Status,
  type Project,
  type StatusItem,
  reportKey,
  reportUrl,
} from "../../apps/hq/contract";
import { agentOutput, parseCli } from "../lib/agent-output";
import { runCf } from "../lib/cf-auth";

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

// ---- answers ---------------------------------------------------------------------------------------------------------

/** The owner's saved picks, in the `{state: {id: {choice, note, at}}}` shape `share-html feedback --json` printed. */
async function answers(): Promise<void> {
  const keys = await listKeys("answers/");
  const saved = await Promise.all(
    keys.map(async (key) => Answer.parse(JSON.parse(await get(key)))),
  );
  const state = Object.fromEntries(
    saved.map(({ id, choice, note, at }) => [id, { choice, note, at }]),
  );
  if (json) console.log(JSON.stringify({ url: `https://${HQ_HOST}/`, state }));
  else if (!saved.length) console.log("hq: no saved picks");
  else for (const a of saved) console.log(`${a.id} ${a.choice || "-"} ${a.note}`.trimEnd());
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
      "Push `status` (from the Housekeeper's state.json) or `report <file.json>` to the site",
    )
    .option("--state <path>", "State file for `push status`, defaults to the Housekeeper's")
    .option("--dry-run", "Validate without uploading")
    .action((what: string, file: string | undefined, options) =>
      run(async () => {
        if (what === "status") return pushStatus(options);
        if (what === "report" && file) return pushReport(file, options);
        throw new Error("hq: use `hq push status` or `hq push report <file.json>`");
      }),
    );
  cli.command("answers", "Print the owner's saved picks").action(() => run(answers));
  cli
    .command("deploy", "Build and deploy the site and its Worker")
    .option("--dry-run", "Build and check without uploading")
    .action((options) => run(() => deploy(options)));
  cli.option("--json", "Emit structured results");
  cli.option("--verbose", "Print details");
  cli.help();
  parseCli(cli);
}
