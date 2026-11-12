import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";

import { execa } from "execa";

export interface PersonalKnowledgeOptions {
  root?: string;
}

export interface PersonalKnowledgeFindOptions extends PersonalKnowledgeOptions {
  keyword?: boolean;
  semantic?: boolean;
  limit?: string;
  minScore?: string;
  format?: "cli" | "json" | "csv" | "md" | "xml" | "files";
  full?: boolean;
}

export interface PersonalKnowledgeNewOptions extends PersonalKnowledgeOptions {
  /** cac sets this to false for `--no-index`. */
  index?: boolean;
}

interface CommandResult {
  stdout: string;
}

export type PersonalKnowledgeRunner = (
  command: string,
  args: string[],
  options?: { capture?: boolean },
) => Promise<CommandResult>;

const COLLECTION = "personal-knowledge";
const INDEX = "personal-knowledge";
const CONTEXT =
  "Mohammed's maintained personal knowledge: life, work, preferences, tools, projects, and decisions.";
const REQUIRED_FRONTMATTER = [
  "title",
  "type",
  "status",
  "confidence",
  "updated",
  "tags",
  "links",
  "sources",
];
const INDEX_SECTIONS: Record<string, string> = {
  profile: "## Profile",
  work: "## Work",
  life: "## Life",
  family: "## Life",
  tools: "## Tools",
  finance: "## Finance",
  projects: "## Projects",
  health: "## Health",
  media: "## Media",
  quotes: "## Quotes",
  synthesis: "## Synthesis",
};

function defaultRoot(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME is required to locate the personal-knowledge repository.");
  }
  return join(home, "PhpstormProjects", "personal-knowledge");
}

function repositoryRoot(options: PersonalKnowledgeOptions): string {
  return resolve(options.root ?? defaultRoot());
}

function wikiRoot(root: string): string {
  return join(root, "wiki");
}

function assertRepository(root: string): void {
  for (const path of ["AGENTS.md", "README.md", "templates/wiki-note.md", "wiki/index.md"]) {
    if (!existsSync(join(root, path))) {
      throw new Error(`Personal knowledge repository is missing required file: ${path}`);
    }
  }
}

function qmdArgs(...args: string[]): string[] {
  return ["--index", INDEX, ...args];
}

const defaultRunner: PersonalKnowledgeRunner = async (command, args, options = {}) => {
  const commandPath = Bun.which(command);
  if (!commandPath) {
    throw new Error(`Required command is not installed: ${command}`);
  }
  const path = process.env.PATH;
  const result = await execa(command, args, {
    env: {
      ...process.env,
      PATH: path ? `${dirname(commandPath)}${delimiter}${path}` : dirname(commandPath),
    },
    stdio: options.capture ? "pipe" : "inherit",
  });
  return { stdout: result.stdout ?? "" };
};

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return markdownFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function titleize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function frontmatter(content: string): string | undefined {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
}

function wikilinkTargets(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) =>
    match[1].trim(),
  );
}

async function updateIndex(root: string, type: string, title: string, slug: string): Promise<void> {
  const section = INDEX_SECTIONS[type.split("/")[0]];
  if (!section) {
    throw new Error(`Cannot index unsupported note type: ${type}`);
  }

  const indexPath = join(wikiRoot(root), "index.md");
  const content = await readFile(indexPath, "utf8");
  const link = `- [[${slug}|${title}]]`;
  if (content.includes(`[[${slug}|`) || content.includes(`[[${slug}]]`)) {
    return;
  }

  const lines = content.split(/\r?\n/);
  const sectionLine = lines.findIndex((line) => line.trim() === section);
  if (sectionLine === -1) {
    throw new Error(`Personal knowledge index is missing section: ${section}`);
  }

  let insertAt = lines.length;
  for (let index = sectionLine + 1; index < lines.length; index++) {
    if (lines[index].startsWith("## ")) {
      insertAt = index;
      break;
    }
  }
  while (insertAt > sectionLine + 1 && lines[insertAt - 1].trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, link, "");
  await writeFile(indexPath, lines.join("\n").replace(/\n+$/, "\n"));
}

export async function personalKnowledgeCheck(
  options: PersonalKnowledgeOptions = {},
): Promise<void> {
  const root = repositoryRoot(options);
  assertRepository(root);
  const files = await markdownFiles(wikiRoot(root));
  const stems = new Map<string, string[]>();
  const contents = new Map<string, string>();
  const failures: string[] = [];

  for (const path of files) {
    const content = await readFile(path, "utf8");
    const key = basename(path, ".md").toLowerCase();
    stems.set(key, [...(stems.get(key) ?? []), path]);
    contents.set(path, content);

    const block = frontmatter(content);
    if (!block) {
      failures.push(`${relative(root, path)} is missing YAML frontmatter`);
      continue;
    }
    for (const field of REQUIRED_FRONTMATTER) {
      if (!new RegExp(`^${field}:`, "m").test(block)) {
        failures.push(`${relative(root, path)} is missing frontmatter field: ${field}`);
      }
    }
  }

  for (const [stem, paths] of stems) {
    if (paths.length > 1) {
      failures.push(
        `duplicate wiki filename "${stem}": ${paths.map((path) => relative(root, path)).join(", ")}`,
      );
    }
  }

  for (const [path, content] of contents) {
    for (const target of wikilinkTargets(content)) {
      const normalized = basename(target, ".md").toLowerCase();
      if (!stems.has(normalized)) {
        failures.push(`${relative(root, path)} references missing wikilink: [[${target}]]`);
      }
    }
  }

  if (failures.length) {
    throw new Error(`Personal knowledge check failed:\n${failures.join("\n")}`);
  }
  console.log(`Personal knowledge check passed (${files.length} wiki documents).`);
}

export async function personalKnowledgeNew(
  type: string,
  title: string,
  options: PersonalKnowledgeNewOptions = {},
): Promise<void> {
  const root = repositoryRoot(options);
  assertRepository(root);
  const normalizedType = type.replace(/^\/+|\/+$/g, "");
  const destination = resolve(wikiRoot(root), normalizedType);
  if (
    !normalizedType ||
    normalizedType.includes("..") ||
    !destination.startsWith(`${wikiRoot(root)}${sep}`) ||
    !INDEX_SECTIONS[normalizedType.split("/")[0]]
  ) {
    throw new Error(`Unsupported personal knowledge note type: ${type}`);
  }

  const noteTitle = titleize(title);
  const slug = slugify(title);
  if (!slug) {
    throw new Error(`Note title cannot produce a slug: ${title}`);
  }
  const path = join(destination, `${slug}.md`);
  if (existsSync(path)) {
    throw new Error(`Personal knowledge note already exists: ${relative(root, path)}`);
  }

  const template = await readFile(join(root, "templates/wiki-note.md"), "utf8");
  const content = template
    .replace(/^title:\s*$/m, `title: ${noteTitle}`)
    .replace(/^type:\s*$/m, `type: ${normalizedType}`)
    .replace(
      /^updated:\s*\d{4}-\d{2}-\d{2}\s*$/m,
      `updated: ${new Date().toISOString().slice(0, 10)}`,
    )
    .replace(/^# Title\s*$/m, `# ${noteTitle}`);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (options.index !== false) {
    await updateIndex(root, normalizedType, noteTitle, slug);
  }
  console.log(`Created personal knowledge note: ${relative(root, path)}`);
}

export async function personalKnowledgeSetup(
  options: PersonalKnowledgeOptions = {},
  runner: PersonalKnowledgeRunner = defaultRunner,
): Promise<void> {
  const root = repositoryRoot(options);
  assertRepository(root);
  const expectedPath = wikiRoot(root);
  let collection: CommandResult | undefined;
  try {
    collection = await runner("qmd", qmdArgs("collection", "show", COLLECTION), {
      capture: true,
    });
  } catch {
    collection = undefined;
  }

  if (collection) {
    if (!collection.stdout.includes(expectedPath)) {
      throw new Error(`qmd collection "${COLLECTION}" points somewhere other than ${expectedPath}`);
    }
  } else {
    await runner("qmd", qmdArgs("collection", "add", expectedPath, "--name", COLLECTION));
  }
  await runner("qmd", qmdArgs("context", "add", `qmd://${COLLECTION}`, CONTEXT));
  await runner("qmd", qmdArgs("embed", "-c", COLLECTION));
  console.log(`Personal knowledge search is ready (${expectedPath}).`);
}

export async function personalKnowledgeReindex(
  options: PersonalKnowledgeOptions = {},
  runner: PersonalKnowledgeRunner = defaultRunner,
): Promise<void> {
  const root = repositoryRoot(options);
  assertRepository(root);
  await runner("qmd", qmdArgs("update"));
  await runner("qmd", qmdArgs("embed", "-c", COLLECTION));
}

export async function personalKnowledgeFind(
  query: string,
  options: PersonalKnowledgeFindOptions = {},
  runner: PersonalKnowledgeRunner = defaultRunner,
): Promise<void> {
  const root = repositoryRoot(options);
  assertRepository(root);
  if (!query.trim()) {
    throw new Error("Search query is required.");
  }
  if (options.keyword && options.semantic) {
    throw new Error("Choose either --keyword or --semantic, not both.");
  }

  const command = options.keyword ? "search" : options.semantic ? "vsearch" : "query";
  const args = qmdArgs(command, query, "-c", COLLECTION, "--full-path");
  if (options.limit) args.push("-n", options.limit);
  if (options.minScore) args.push("--min-score", options.minScore);
  if (options.format) args.push("--format", options.format);
  if (options.full) args.push("--full");
  await runner("qmd", args);
}

export async function personalKnowledgeStatus(
  options: PersonalKnowledgeOptions = {},
  runner: PersonalKnowledgeRunner = defaultRunner,
): Promise<void> {
  const root = repositoryRoot(options);
  assertRepository(root);
  const wikiFiles = await markdownFiles(wikiRoot(root));
  const rawRoot = join(root, "raw");
  const rawFiles = existsSync(rawRoot)
    ? (await readdir(rawRoot, { recursive: true, withFileTypes: true })).filter((entry) =>
        entry.isFile(),
      ).length
    : 0;

  console.log(`Repository: ${root}`);
  console.log(`Wiki documents: ${wikiFiles.length}`);
  console.log(`Raw inbox files: ${rawFiles}`);
  await personalKnowledgeCheck(options);
  await runner("qmd", qmdArgs("status"));
}
