// Finds recorded product decisions (docs/decisions/**/*.md) by meaning through an isolated qmd hybrid index per project.
// Each checkout (canonical clone or task worktree) gets its own collection in the project's index; qmd keys embeddings by
// content hash, so a new worktree reuses the vectors its clone already has.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { execa } from "execa";

import { ACTIVE_PROJECTS, type ActiveProject } from "../../config/active-projects";

export const EXIT = { found: 0, none: 1, usage: 2, failed: 3 } as const;

const DECISIONS_DIR = join("docs", "decisions");
const INTENT = "Recorded product decisions that govern or rule out this change";
const REASON_LIMIT = 160;

export class DecisionsError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.usage,
  ) {
    super(message);
  }
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type QmdRunner = (
  args: string[],
  env: Record<string, string>,
  cwd: string,
) => Promise<RunResult>;

export const qmdRunner: QmdRunner = async (args, env, cwd) => {
  if (!Bun.which("qmd")) throw new DecisionsError("qmd is not installed; run doctor", EXIT.failed);
  const result = await execa("qmd", args, {
    cwd,
    env: { ...env, NO_COLOR: "1" },
    reject: false,
    stdin: "ignore",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
};

export interface Checkout {
  project: string;
  root: string;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const result = await execa("git", args, { cwd, reject: false, stdin: "ignore" });
  return result.exitCode === 0 ? String(result.stdout).trim() : undefined;
}

// Compares remotes regardless of protocol, user, `.git` suffix, and case.
export function repositoryKey(url: string): string {
  return url
    .trim()
    .replace(/\.git\/?$/, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, "")
    .toLowerCase();
}

// The project comes from the cwd's git checkout, whose origin or shared .git also identifies T3 worktrees.
export async function resolveCheckout(
  cwd: string,
  requested?: string,
  projects: ActiveProject[] = ACTIVE_PROJECTS,
): Promise<Checkout> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const remote = root && (await git(root, ["remote", "get-url", "origin"]));
  const commonDir =
    root && (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const mainRoot = commonDir ? dirname(resolve(commonDir)) : undefined;
  const detected = projects.find(
    (project) =>
      (remote && repositoryKey(project.remoteUrl) === repositoryKey(remote)) ||
      (mainRoot && resolve(project.canonicalRoot) === mainRoot),
  );

  if (requested) {
    const chosen = projects.find((project) => project.id === requested);
    if (!chosen) {
      throw new DecisionsError(
        `unknown project ${requested}; use ${projects.map(({ id }) => id).join("|")}`,
      );
    }
    return {
      project: chosen.id,
      root: root && detected === chosen ? resolve(root) : chosen.canonicalRoot,
    };
  }
  if (root && detected) return { project: detected.id, root: resolve(root) };
  if (root && existsSync(join(root, DECISIONS_DIR))) {
    const project = basename(mainRoot ?? root)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    return { project, root: resolve(root) };
  }
  throw new DecisionsError(
    `not inside an active project checkout; pass --project ${projects.map(({ id }) => id).join("|")}`,
  );
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

// Paths, sizes, and modification times change whenever a decision is added, edited, moved, or deleted.
export function fingerprint(dir: string): string {
  const hash = createHash("sha1");
  for (const path of markdownFiles(dir)) {
    const stat = statSync(path);
    hash.update(`${relative(dir, path)}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

export function defaultStateRoot(): string {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "my-setup",
    "decisions",
  );
}

interface Registration {
  root: string;
  fingerprint: string;
}

export class DecisionIndex {
  readonly stateDir: string;
  readonly collection: string;
  readonly decisionsDir: string;
  readonly env: Record<string, string>;

  constructor(
    readonly checkout: Checkout,
    stateRoot = defaultStateRoot(),
    private readonly run: QmdRunner = qmdRunner,
    private readonly verbose = false,
  ) {
    this.stateDir = join(stateRoot, checkout.project);
    this.collection = DecisionIndex.collectionFor(checkout);
    this.decisionsDir = join(checkout.root, DECISIONS_DIR);
    // INDEX_PATH and QMD_CONFIG_DIR keep this index apart from qmd's default and personal-knowledge indexes; models stay shared.
    this.env = {
      ...(process.env as Record<string, string>),
      INDEX_PATH: join(this.stateDir, "index.sqlite"),
      QMD_CONFIG_DIR: join(this.stateDir, "qmd"),
    };
  }

  static collectionFor(checkout: Checkout): string {
    return `${checkout.project}-${createHash("sha1").update(checkout.root).digest("hex").slice(0, 10)}`;
  }

  private registrationPath(collection: string): string {
    return join(this.stateDir, "collections", `${collection}.json`);
  }

  private readRegistration(collection: string): Registration | undefined {
    try {
      return JSON.parse(readFileSync(this.registrationPath(collection), "utf8")) as Registration;
    } catch {
      return undefined;
    }
  }

  private qmdKnows(collection: string): boolean {
    const config = join(this.env.QMD_CONFIG_DIR, "index.yml");
    return (
      existsSync(config) && new RegExp(`^  ${collection}:`, "m").test(readFileSync(config, "utf8"))
    );
  }

  private async qmd(...args: string[]): Promise<string> {
    const result = await this.run(args, this.env, this.stateDir);
    if (this.verbose)
      process.stderr.write(`$ qmd ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    if (result.exitCode !== 0) {
      const log = join(mkdtempSync(join(tmpdir(), "decisions-log-")), "qmd.log");
      writeFileSync(log, `qmd ${args.join(" ")}\n${result.stdout}\n${result.stderr}\n`, {
        mode: 0o600,
      });
      throw new DecisionsError(
        `qmd ${args[0]} failed (exit ${result.exitCode}); log: ${log}`,
        EXIT.failed,
      );
    }
    return result.stdout;
  }

  // Drops collections of checkouts whose decisions folder is gone, such as removed worktrees.
  private async prune(): Promise<void> {
    const dir = join(this.stateDir, "collections");
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      const collection = basename(file, ".json");
      const registration = this.readRegistration(collection);
      if (
        collection === this.collection ||
        (registration && existsSync(join(registration.root, DECISIONS_DIR)))
      ) {
        continue;
      }
      if (this.qmdKnows(collection)) await this.qmd("collection", "remove", collection);
      rmSync(join(dir, file), { force: true });
    }
  }

  // Indexes incrementally whenever decision files changed since the last run; returns whether it reindexed.
  async ensureFresh(): Promise<boolean> {
    if (!existsSync(this.decisionsDir))
      throw new DecisionsError(`no ${DECISIONS_DIR} in ${this.checkout.root}`);
    const current = fingerprint(this.decisionsDir);
    const known = this.qmdKnows(this.collection);
    if (known && this.readRegistration(this.collection)?.fingerprint === current) return false;

    mkdirSync(join(this.stateDir, "collections"), { recursive: true });
    await this.prune();
    if (known) await this.qmd("update");
    else
      await this.qmd(
        "collection",
        "add",
        this.decisionsDir,
        "--name",
        this.collection,
        "--mask",
        "**/*.md",
      );
    await this.qmd("embed", "-c", this.collection);
    const registration: Registration = { root: this.checkout.root, fingerprint: current };
    writeFileSync(this.registrationPath(this.collection), `${JSON.stringify(registration)}\n`);
    return true;
  }

  async search(
    task: string,
    options: { keywords?: string; limit?: number } = {},
  ): Promise<Decision[]> {
    const query = structuredQuery(task, options.keywords);
    const output = await this.qmd(
      "query",
      query,
      "-c",
      this.collection,
      "--format",
      "json",
      "-n",
      String(options.limit ?? 5),
    );
    return parseResults(output, this.collection, this.decisionsDir);
  }
}

export interface Decision {
  path: string;
  title: string;
  reason: string;
  score: number;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// qmd typed lines must be single lines with balanced double quotes.
function balanced(text: string): string {
  const line = singleLine(text);
  return (line.match(/"/g)?.length ?? 0) % 2 === 0 ? line : line.replaceAll('"', "");
}

// Hybrid search measured best this way: keywords drive BM25 (all must match), the task sentence drives vectors.
export function structuredQuery(task: string, keywords?: string): string {
  const vec = singleLine(task).replaceAll('"', "");
  if (!vec) throw new DecisionsError("describe the task in plain words");
  const lex = keywords ? balanced(keywords) : "";
  return [`intent: ${INTENT}`, ...(lex ? [`lex: ${lex}`] : []), `vec: ${vec}`].join("\n");
}

export function titleFromPath(path: string): string {
  const words = basename(path, ".md").replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function reasonFromSnippet(snippet: string): string {
  const text = singleLine(snippet.replace(/^@@[^\n]*\n/, "")).replace(/\.\.\.$/, "");
  if (text.length <= REASON_LIMIT) return text;
  const cut = text.slice(0, REASON_LIMIT);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : REASON_LIMIT).replace(/[,;:]$/, "")}…`;
}

export function parseResults(output: string, collection: string, decisionsDir: string): Decision[] {
  const prefix = `qmd://${collection}/`;
  let rows: Array<{ file?: string; score?: number; snippet?: string }>;
  try {
    rows = JSON.parse(output || "[]");
  } catch {
    throw new DecisionsError("qmd returned unreadable results; rerun with --verbose", EXIT.failed);
  }
  return rows
    .filter((row) => row.file?.startsWith(prefix))
    .map((row) => {
      const path = join(decisionsDir, ...row.file!.slice(prefix.length).split("/"));
      return {
        path,
        title: titleFromPath(path),
        reason: reasonFromSnippet(row.snippet ?? ""),
        score: row.score ?? 0,
      };
    });
}

// Paths read relative to the cwd when the checkout contains it, so agents can open them directly.
export function displayPath(path: string, cwd: string, root: string): string {
  const inside = relative(root, cwd);
  if (inside.startsWith("..") || isAbsolute(inside)) return path;
  return relative(cwd, path).split(sep).join("/");
}

export function formatResults(decisions: Decision[], cwd: string, root: string): string {
  return decisions
    .map(
      ({ path, title, reason, score }) =>
        `${displayPath(path, cwd, root)} [${score.toFixed(2)}] ${title}: ${reason}`,
    )
    .join("\n");
}

export function formatFull(decisions: Decision[], cwd: string, root: string): string {
  return decisions
    .map(
      ({ path }) =>
        `==> ${displayPath(path, cwd, root)} <==\n${readFileSync(path, "utf8").trimEnd()}`,
    )
    .join("\n\n");
}
