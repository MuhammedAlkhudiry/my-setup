import { randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import { execa } from "execa";

// Cloudflare setup this command relies on: the R2 bucket has a lifecycle rule that deletes
// objects after RETENTION_DAYS, and SHARE_HOST is its custom domain behind Cloudflare Access.
export const SHARE_BUCKET = "shared-html";
export const SHARE_HOST = "share.harium.app";
export const RETENTION_DAYS = 30;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const UPLOAD_CONCURRENCY = 4;
const LOCAL_ONLY_REFERENCE =
  /(?:\b(?:src|href|action|poster)\s*=\s*["']?|url\(\s*["']?|fetch\(\s*["'])((?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/"'\s]+\.(?:test|localhost))(?::\d+)?|file:)[^"'\s)]*)/gi;
const RELATIVE_REFERENCE = /(?:\b(?:src|href|poster)\s*=\s*["']|url\(\s*["']?)([^"'\s)#?]+)/gi;
const EXTERNAL_PREFIX = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

interface ShareOptions {
  name?: string;
  dryRun?: boolean;
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

export function artifactPrefix(name: string, now = new Date()): string {
  return `${now.toISOString().slice(0, 10)}-${slugify(name)}-${randomBytes(4).toString("hex")}`;
}

export function findLocalOnlyReferences(html: string): string[] {
  return [...new Set([...html.matchAll(LOCAL_ONLY_REFERENCE)].map((match) => match[1] ?? ""))];
}

export function findRelativeReferences(html: string): string[] {
  const references = [...html.matchAll(RELATIVE_REFERENCE)].map((match) => match[1] ?? "");
  return [...new Set(references.filter((reference) => !EXTERNAL_PREFIX.test(reference)))];
}

async function collectFiles(root: string, dir = root): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, path)));
    } else if (entry.isFile()) {
      files.push({ path, key: relative(root, path).split("\\").join("/"), size: (await stat(path)).size });
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

async function assertPortable(files: ArtifactFile[]): Promise<void> {
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
  const response = await fetch(`https://${SHARE_HOST}/`, { redirect: "manual" }).catch(
    (error: Error) => {
      throw new Error(`Cannot reach ${SHARE_HOST}: ${error.message}`);
    },
  );
  const location = response.headers.get("location") ?? "";
  if (!(response.status >= 300 && response.status < 400 && location.includes("cloudflareaccess.com"))) {
    throw new Error(
      `${SHARE_HOST} is not behind Cloudflare Access (HTTP ${response.status}); refusing to publish.`,
    );
  }
}

async function uploadFile(prefix: string, file: ArtifactFile): Promise<void> {
  const contentType = Bun.file(file.path).type || "application/octet-stream";
  await execa(
    "bunx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${SHARE_BUCKET}/${prefix}/${file.key}`,
      "--file",
      file.path,
      "--content-type",
      contentType,
      "--remote",
    ],
    // A neutral cwd keeps a project's wrangler config from redirecting the upload.
    { cwd: tmpdir() },
  ).catch((error: { stderr?: string; message: string }) => {
    throw new Error(`Upload of ${file.key} failed: ${error.stderr?.trim() || error.message}`);
  });
}

async function upload(prefix: string, files: ArtifactFile[]): Promise<void> {
  // The first upload runs alone so parallel wrangler processes never race to refresh its OAuth token.
  const [first, ...rest] = files;
  if (first) await uploadFile(prefix, first);
  const worker = async () => {
    for (let file = rest.shift(); file; file = rest.shift()) await uploadFile(prefix, file);
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

export async function shareHtml(input: string, options: ShareOptions): Promise<void> {
  const { files, name } = await resolveArtifact(input);
  await assertPortable(files);

  const prefix = artifactPrefix(options.name || name);
  const url = `https://${SHARE_HOST}/${prefix}/index.html`;
  const total = files.reduce((sum, file) => sum + file.size, 0);

  if (options.dryRun) {
    console.log(`Would publish ${files.length} files (${formatBytes(total)}) to ${url}`);
    for (const file of files) console.log(`  ${file.key} (${formatBytes(file.size)})`);
    return;
  }

  await assertAccessProtected();
  await upload(prefix, files);

  const expires = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(url);
  console.log(
    `${files.length} files, ${formatBytes(total)}. Deleted automatically after ${expires.toISOString().slice(0, 10)}.`,
  );
}
