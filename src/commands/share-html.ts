import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { S3Client } from "bun";

import { runCf } from "../lib/cf-auth";

// Cloudflare setup this command relies on: the R2 bucket has a lifecycle rule that deletes
// objects after RETENTION_DAYS, and SHARE_HOST is its custom domain behind Cloudflare Access.
// Writable pages also need a CORS rule on the bucket that allows PUT from SHARE_HOST, and an
// R2 API token whose access key ID is in PARENT_KEY_ENV; only short-lived child keys leave this Mac.
export const SHARE_BUCKET = "shared-html";
export const SHARE_HOST = "share.harium.app";
export const SHARE_ZONE = "harium.app";
export const SHARE_ACCOUNT_ID = "79e2c6100c3c858bea905f9f200823b5";
export const RETENTION_DAYS = 30;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export const FEEDBACK_KEY = "feedback.json";
export const FEEDBACK_ENDPOINT_KEY = "feedback-endpoint.json";
export const FEEDBACK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const PARENT_KEY_ENV = "SHARE_HTML_R2_PARENT_ACCESS_KEY_ID";
const WRITABLE_INDEX = join(homedir(), ".local", "state", "share-html", "writable.json");
const WRITABLE_INDEX_LIMIT = 50;
const PREFIX_PATTERN = /^(?:https?:\/\/[^/]+\/)?(\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[0-9a-f]{8})(?:\/|$)/;
const SHARE_URL_PATTERN = new RegExp(
  `^https?://${SHARE_HOST.replaceAll(".", "\\.")}/([a-z0-9-]+)(?:/|$)`,
);

const UPLOAD_CONCURRENCY = 4;
const LOCAL_ONLY_REFERENCE =
  /(?:\b(?:src|href|action|poster)\s*=\s*["']?|url\(\s*["']?|fetch\(\s*["'])((?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/"'\s]+\.(?:test|localhost))(?::\d+)?|file:)[^"'\s)]*)/gi;
const RELATIVE_REFERENCE = /(?:\b(?:src|href|poster)\s*=\s*["']|url\(\s*["']?)([^"'\s)#?]+)/gi;
const EXTERNAL_PREFIX = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

interface ShareOptions {
  name?: string;
  dryRun?: boolean;
  writable?: boolean;
  stable?: boolean;
}

interface WritablePage {
  prefix: string;
  publishedAt: string;
}

interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface ArtifactFile {
  path: string;
  key: string;
  size: number;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/\.html?$/, "")
    .replace(/\.[a-z0-9]{4,}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "artifact";
}

export function artifactPrefix(
  name: string,
  now = new Date(),
  suffix = randomBytes(4).toString("hex"),
): string {
  return `${now.toISOString().slice(0, 10)}-${slugify(name)}-${suffix}`;
}

/** A stable page keeps one URL across publishes: the slug alone, with no date or random suffix. */
export function stablePrefix(name: string): string {
  return slugify(name);
}

export function findLocalOnlyReferences(html: string): string[] {
  return [...new Set([...html.matchAll(LOCAL_ONLY_REFERENCE)].map((match) => match[1] ?? ""))];
}

export function findRelativeReferences(html: string): string[] {
  const references = [...html.matchAll(RELATIVE_REFERENCE)].map((match) => match[1] ?? "");
  return [...new Set(references.filter((reference) => !EXTERNAL_PREFIX.test(reference)))];
}

export async function collectFiles(root: string, dir = root): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, path)));
    } else if (entry.isFile()) {
      files.push({
        path,
        key: relative(root, path).split("\\").join("/"),
        size: (await stat(path)).size,
      });
    }
  }
  return files;
}

async function resolveArtifact(input: string): Promise<{ files: ArtifactFile[]; name: string }> {
  const path = resolve(input);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`${input} does not exist`);

  if (info.isFile()) {
    if (!/\.html?$/i.test(path)) throw new Error(`${input} is not an HTML file`);
    const relativeReferences = findRelativeReferences(await readFile(path, "utf8"));
    if (relativeReferences.length > 0) {
      throw new Error(
        `${input} references local files (${relativeReferences.slice(0, 3).join(", ")}). ` +
          "Put the page and its assets in a folder with index.html and share the folder.",
      );
    }
    const name = basename(path) === "index.html" ? basename(resolve(path, "..")) : basename(path);
    return { files: [{ path, key: "index.html", size: info.size }], name };
  }

  const files = await collectFiles(path);
  if (!files.some((file) => file.key === "index.html")) {
    throw new Error(`${input} has no index.html at its top level`);
  }
  return { files, name: basename(path) };
}

export async function assertPortable(files: ArtifactFile[]): Promise<void> {
  const problems: string[] = [];
  for (const file of files.filter((candidate) => /\.(?:html?|css|js)$/i.test(candidate.key))) {
    for (const reference of findLocalOnlyReferences(await readFile(file.path, "utf8"))) {
      problems.push(`${file.key}: ${reference}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Links that only work on this Mac:\n  ${problems.join("\n  ")}`);
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    const largest = [...files]
      .sort((a, b) => b.size - a.size)
      .slice(0, 5)
      .map((file) => `${file.key} (${formatBytes(file.size)})`);
    throw new Error(
      `Artifact is ${formatBytes(total)}; the limit is ${formatBytes(MAX_TOTAL_BYTES)}. ` +
        `Largest files: ${largest.join(", ")}`,
    );
  }
}

async function assertAccessProtected(): Promise<void> {
  const response = await fetch(`https://${SHARE_HOST}/`, {
    redirect: "manual",
  }).catch((error: Error) => {
    throw new Error(`Cannot reach ${SHARE_HOST}: ${error.message}`);
  });
  const location = response.headers.get("location") ?? "";
  if (
    !(response.status >= 300 && response.status < 400 && location.includes("cloudflareaccess.com"))
  ) {
    throw new Error(
      `${SHARE_HOST} is not behind Cloudflare Access (HTTP ${response.status}); refusing to publish.`,
    );
  }
}

/** Upload attempts per file; one dropped connection or timeout should not abort a large publish. */
export const UPLOAD_ATTEMPTS = 3;

/** Runs `task` up to `attempts` times, waiting longer before each retry, and throws the last error. */
export async function withRetry<T>(
  task: () => Promise<T>,
  attempts: number,
  delayMs: (attempt: number) => number = (attempt) => 1000 * 2 ** (attempt - 1),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await Bun.sleep(delayMs(attempt));
    }
  }
}

async function uploadFile(prefix: string, file: ArtifactFile): Promise<void> {
  const contentType = Bun.file(file.path).type || "application/octet-stream";
  const put = () =>
    runCf([
      "r2",
      "objects",
      "put",
      `${prefix}/${file.key}`,
      "--bucket-name",
      SHARE_BUCKET,
      "--file",
      file.path,
      "--content-type",
      contentType,
      "--quiet",
    ]);

  await withRetry(put, UPLOAD_ATTEMPTS).catch((error: { stderr?: string; message: string }) => {
    throw new Error(
      `Upload of ${file.key} failed after ${UPLOAD_ATTEMPTS} attempts: ${error.stderr?.trim() || error.message}`,
    );
  });
}

async function upload(prefix: string, files: ArtifactFile[]): Promise<void> {
  // The first upload runs alone so parallel cf processes never race to refresh its OAuth token.
  const [first, ...rest] = files;
  if (first) await uploadFile(prefix, first);
  const worker = async () => {
    for (let file = rest.shift(); file; file = rest.shift()) await uploadFile(prefix, file);
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for (let startAfter: string | undefined; ; ) {
    const { stdout } = await runCf([
      "r2",
      "objects",
      "list",
      "--bucket-name",
      SHARE_BUCKET,
      "--prefix",
      `${prefix}/`,
      "--per-page",
      "1000",
      ...(startAfter ? ["--start-after", startAfter] : []),
    ]);
    const page = (JSON.parse(stdout) as { key: string }[]).map((object) => object.key);
    keys.push(...page);
    if (page.length < 1000) return keys;
    startAfter = page.at(-1);
  }
}

/** Keys under a stable prefix that the new publish no longer has; saved feedback stays. */
export function staleKeys(existing: string[], prefix: string, published: ArtifactFile[]): string[] {
  const kept = new Set([
    ...published.map((file) => `${prefix}/${file.key}`),
    `${prefix}/${FEEDBACK_KEY}`,
  ]);
  return existing.filter((key) => !kept.has(key));
}

async function deleteKeys(keys: string[]): Promise<void> {
  for (let start = 0; start < keys.length; start += 1000) {
    await runCf([
      "r2",
      "objects",
      "bulk-delete",
      "--bucket-name",
      SHARE_BUCKET,
      "--force",
      "--body",
      JSON.stringify(keys.slice(start, start + 1000)),
    ]);
  }
}

/** A stable URL serves new bytes under old paths, so the edge must forget the old ones. */
async function purgeCache(prefix: string): Promise<void> {
  await runCf([
    "cache",
    "purge",
    "--zone",
    SHARE_ZONE,
    "--force",
    "--body",
    JSON.stringify({ prefixes: [`${SHARE_HOST}/${prefix}/`] }),
  ]);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

const pageUrl = (prefix: string) => `https://${SHARE_HOST}/${prefix}/index.html`;

/** Pulls the artifact prefix out of a share URL or a bare prefix. */
export function prefixFromRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  return trimmed.match(PREFIX_PATTERN)?.[1] ?? trimmed.match(SHARE_URL_PATTERN)?.[1];
}

/** Finds the credentials in `cf r2 temporary-credentials create` output, whatever its envelope. */
export function parseTemporaryCredentials(output: string): TemporaryCredentials {
  const pick = (value: unknown): TemporaryCredentials | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const field = (...names: string[]) =>
      names.map((name) => record[name]).find((v) => typeof v === "string") as string | undefined;
    const accessKeyId = field("accessKeyId", "access_key_id");
    const secretAccessKey = field("secretAccessKey", "secret_access_key");
    const sessionToken = field("sessionToken", "session_token");
    if (accessKeyId && secretAccessKey && sessionToken)
      return { accessKeyId, secretAccessKey, sessionToken };
    return Object.values(record).map(pick).find(Boolean);
  };

  const start = output.indexOf("{");
  const credentials = start >= 0 ? pick(JSON.parse(output.slice(start))) : undefined;
  if (!credentials) throw new Error("cf returned no temporary credentials");
  return credentials;
}

/** Picks the page `share-html feedback` reads: a URL or prefix, else the newest page whose name matches, else the newest. */
export function resolveWritablePage(pages: WritablePage[], ref?: string): string | undefined {
  const direct = ref ? prefixFromRef(ref) : undefined;
  if (direct) return direct;

  const newestFirst = [...pages].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!ref) return newestFirst[0]?.prefix;

  const slug = slugify(ref);
  return newestFirst.find((page) => page.prefix.includes(slug))?.prefix;
}

async function readWritableIndex(): Promise<WritablePage[]> {
  return JSON.parse(await readFile(WRITABLE_INDEX, "utf8").catch(() => "[]")) as WritablePage[];
}

async function rememberWritablePage(prefix: string): Promise<void> {
  const earlier = (await readWritableIndex()).filter((page) => page.prefix !== prefix);
  const pages = [{ prefix, publishedAt: new Date().toISOString() }, ...earlier];
  await mkdir(dirname(WRITABLE_INDEX), { recursive: true });
  await writeFile(WRITABLE_INDEX, JSON.stringify(pages.slice(0, WRITABLE_INDEX_LIMIT), null, 2));
}

function parentAccessKeyId(): string {
  const id = process.env[PARENT_KEY_ENV];
  if (!id) {
    throw new Error(
      `${PARENT_KEY_ENV} is not set. Create an R2 API token with Object Read & Write on ${SHARE_BUCKET} ` +
        "and put its Access Key ID in the local secrets file.",
    );
  }
  return id;
}

/**
 * Mints a presigned PUT URL that can write only this page's feedback file, and stores it in a file
 * uploaded beside the page. The page itself is behind Cloudflare Access, so only the owner sees the URL.
 */
async function createFeedbackEndpoint(prefix: string, parentKeyId: string): Promise<ArtifactFile> {
  const key = `${prefix}/${FEEDBACK_KEY}`;
  const { stdout } = await runCf([
    "r2",
    "temporary-credentials",
    "create",
    "--bucket",
    SHARE_BUCKET,
    "--parent-access-key-id",
    parentKeyId,
    "--permission",
    "object-read-write",
    "--objects",
    key,
    "--ttl-seconds",
    String(FEEDBACK_TTL_SECONDS),
  ]);

  const client = new S3Client({
    ...parseTemporaryCredentials(stdout),
    bucket: SHARE_BUCKET,
    endpoint: `https://${SHARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  });
  const put = client.presign(key, {
    method: "PUT",
    expiresIn: FEEDBACK_TTL_SECONDS,
  });
  const expires = new Date(Date.now() + FEEDBACK_TTL_SECONDS * 1000).toISOString();

  const path = join(await mkdtemp(join(tmpdir(), "share-html-endpoint-")), FEEDBACK_ENDPOINT_KEY);
  await writeFile(path, JSON.stringify({ put, expires }));
  return { path, key: FEEDBACK_ENDPOINT_KEY, size: (await stat(path)).size };
}

export async function shareHtml(input: string, options: ShareOptions): Promise<void> {
  if (options.stable && !options.name) {
    throw new Error("--stable needs --name, so two folders with the same name never share a URL");
  }

  const { files, name } = await resolveArtifact(input);
  await assertPortable(files);

  const total = files.reduce((sum, file) => sum + file.size, 0);

  if (options.dryRun) {
    // Each publish draws a new random suffix, so a dry run can only show the URL's shape.
    const example = options.stable
      ? stablePrefix(options.name || name)
      : artifactPrefix(options.name || name, new Date(), "<random>");
    if (process.argv.includes("--json")) {
      console.log(
        JSON.stringify({
          dryRun: true,
          url: `https://${SHARE_HOST}/${example}/index.html`,
          files: files.map((file) => ({ key: file.key, size: file.size })),
          totalBytes: total,
          writable: !!options.writable,
        }),
      );
      return;
    }
    console.log(
      `Would publish ${files.length} files (${formatBytes(total)}) to https://${SHARE_HOST}/${example}/index.html`,
    );
    for (const file of files) console.log(`  ${file.key} (${formatBytes(file.size)})`);
    if (options.writable)
      console.log(`  + ${FEEDBACK_ENDPOINT_KEY} (lets the page save feedback for 7 days)`);
    return;
  }

  const parentKeyId = options.writable ? parentAccessKeyId() : undefined;
  const prefix = options.stable
    ? stablePrefix(options.name || name)
    : artifactPrefix(options.name || name);
  await assertAccessProtected();

  const endpoint = parentKeyId ? await createFeedbackEndpoint(prefix, parentKeyId) : undefined;
  const published = endpoint ? [...files, endpoint] : files;
  await upload(prefix, published);
  if (options.stable) {
    await deleteKeys(staleKeys(await listKeys(prefix), prefix, published));
    await purgeCache(prefix);
  }
  if (endpoint) await rememberWritablePage(prefix);

  const expires = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify({
        url: pageUrl(prefix),
        files: files.length,
        totalBytes: total,
        expiresAt: expires.toISOString(),
        writable: !!endpoint,
        stable: !!options.stable,
      }),
    );
    return;
  }
  console.log(pageUrl(prefix));
  console.log(
    `${files.length} files, ${formatBytes(total)}. Deleted automatically after ${expires.toISOString().slice(0, 10)}` +
      (options.stable ? " unless published again; the URL stays the same." : "."),
  );
  if (endpoint)
    console.log('Writable for 7 days. When the user says "see", run `share-html feedback`.');
}

/** Prints the feedback a writable page saved, for the agent to act on. */
export async function readFeedback(ref?: string): Promise<void> {
  const prefix = resolveWritablePage(await readWritableIndex(), ref);
  if (!prefix) {
    throw new Error(
      ref
        ? `No writable page matches "${ref}".`
        : "No writable page has been published from this Mac yet.",
    );
  }

  const result = await runCf(
    ["r2", "objects", "get", `${prefix}/${FEEDBACK_KEY}`, "--bucket-name", SHARE_BUCKET],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    if (/does not exist|10007/.test(result.stderr)) {
      console.log(
        process.argv.includes("--json")
          ? JSON.stringify({
              url: pageUrl(prefix),
              savedAt: null,
              markdown: null,
            })
          : `No feedback saved yet on ${pageUrl(prefix)}`,
      );
      return;
    }
    throw new Error(`Reading feedback failed: ${result.stderr.trim()}`);
  }

  const saved = JSON.parse(result.stdout) as {
    markdown?: string;
    savedAt?: string;
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ url: pageUrl(prefix), ...saved }));
    return;
  }
  console.log(`Saved ${saved.savedAt ?? "at an unknown time"} on ${pageUrl(prefix)}\n`);
  console.log(saved.markdown?.trim() || "(The page saved no summary.)");
}
