import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { execa } from "execa";
import { chromium, type Page } from "playwright-core";

import { assertPortable, collectFiles, slugify } from "./share-html";

const ASSETS = resolve(import.meta.dir, "../../content/skills/workflow/html-artifacts/assets");
const KIT_DIR = "mockup-kit";
const KINDS = ["options", "plan-review", "blank"] as const;
type Kind = (typeof KINDS)[number];

const BLANK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TITLE</title>
<!-- THEME: paste assets/theme.html here -->
<!-- KIT -->
</head>
<body>
<main class="page"></main>
</body>
</html>
`;

const EXAMPLE_FRAGMENT = `<!-- One option's mockup. With a project kit, draw real screens with its frame classes; see mockup-kit/README.md in the project. -->
<div class="card card-body">Option mockup</div>
`;

interface KitManifest {
  css: string[];
  fonts?: { dir: string; files: string[] };
  images?: { dir: string; width: number };
}

interface Kit {
  root: string;
  manifest: KitManifest;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function projectRoot(from: string): Promise<string | null> {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], { cwd: from, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function findKit(root: string | null): Promise<Kit | null> {
  if (!root) return null;
  const path = join(root, KIT_DIR, "kit.json");
  if (!(await exists(path))) return null;
  return { root, manifest: JSON.parse(await readFile(path, "utf8")) as KitManifest };
}

// Folder names follow `<project>-<topic>.XXXX`; a repo named `harium-project` is the `harium` project. A worktree's own folder name
// says nothing about the project, so read the name from the shared git directory.
async function projectName(root: string | null): Promise<string> {
  if (!root) return "page";
  const result = await execa("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root });
  return slugify(basename(dirname(result.stdout.trim())).replace(/-project$/, ""));
}

async function addImages(folder: string, kit: Kit, names: string[]): Promise<void> {
  const images = kit.manifest.images;
  if (!images) throw new Error(`${KIT_DIR}/kit.json has no images entry`);

  const sourceDir = join(kit.root, images.dir);
  const stem = (file: string) => file.replace(/\.[^.]+$/, "");
  const available = (await readdir(sourceDir)).filter((file) => /\.(webp|png|jpe?g)$/i.test(file));
  await mkdir(join(folder, "kit", "images"), { recursive: true });

  for (const name of names) {
    const source = available.find((file) => stem(file) === name);
    if (!source) {
      throw new Error(`No image named "${name}". Available: ${available.map(stem).join(", ")}`);
    }
    await execa("cwebp", ["-quiet", "-resize", String(images.width), "0", "-q", "82", join(sourceDir, source), "-o", join(folder, "kit", "images", `${name}.webp`)]);
  }
}

async function copyKit(folder: string, kit: Kit): Promise<void> {
  const target = join(folder, "kit");
  await mkdir(join(target, "fonts"), { recursive: true });

  for (const css of kit.manifest.css) await copyFile(join(kit.root, KIT_DIR, css), join(target, basename(css)));

  const { dir, files = [] } = kit.manifest.fonts ?? { dir: "" };
  for (const file of files) await copyFile(join(kit.root, dir, file), join(target, "fonts", file));
}

function renderTemplate(template: string, theme: string, kitCss: string[]): string {
  const kitLinks = kitCss.map((css) => `<link rel="stylesheet" href="kit/${basename(css)}">`).join("\n");
  return template.replace("<!-- THEME: paste assets/theme.html here -->", theme.trim()).replace("<!-- KIT -->", kitLinks);
}

export async function createArtifact(kind: string, topic: string, options: { images?: string; project?: string }): Promise<void> {
  if (!KINDS.includes(kind as Kind)) throw new Error(`Unknown kind "${kind}". Use one of: ${KINDS.join(", ")}`);

  const root = await projectRoot(resolve(options.project ?? process.cwd()));
  const kit = await findKit(root);
  const folder = await mkdtemp(join(tmpdir(), `${await projectName(root)}-${slugify(topic)}.`));

  const theme = await readFile(join(ASSETS, "theme.html"), "utf8");
  const template = kind === "blank" ? BLANK : await readFile(join(ASSETS, `${kind}.html`), "utf8");
  await writeFile(join(folder, "index.html"), renderTemplate(template, theme, kit?.manifest.css ?? []));
  if (kind !== "blank") await copyFile(join(ASSETS, "feedback.js"), join(folder, "feedback.js"));

  if (kind === "options") {
    await mkdir(join(folder, "options"));
    await writeFile(join(folder, "options", "O1.html"), EXAMPLE_FRAGMENT);
    await writeFile(join(folder, "options", "O2.html"), EXAMPLE_FRAGMENT);
  }

  if (kit) await copyKit(folder, kit);
  const images = (options.images ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (images.length) {
    if (!kit) throw new Error(`--images needs a ${KIT_DIR}/kit.json in the project`);
    await addImages(folder, kit, images);
  }

  console.log(folder);
  console.log(kit ? `Kit: ${join(kit.root, KIT_DIR, "README.md")}` : "Kit: none in this project");
}

export async function addImagesToArtifact(folder: string, names: string[], options: { project?: string }): Promise<void> {
  const kit = await findKit(await projectRoot(resolve(options.project ?? process.cwd())));
  if (!kit) throw new Error(`No ${KIT_DIR}/kit.json in this project; run from the project or pass --project`);
  await addImages(resolve(folder), kit, names);
}

// --- check ---

interface Shot {
  name: string;
  width: number;
  height: number;
  scheme: "light" | "dark";
  hash?: string;
}

async function layoutIssues(page: Page, shot: Shot): Promise<string[]> {
  return page.evaluate((desktop) => {
    const issues: string[] = [];
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) issues.push(`scrolls sideways (${root.scrollWidth}px wide in ${root.clientWidth}px)`);
    if (desktop && root.scrollHeight > root.clientHeight + 1) issues.push(`scrolls down (${root.scrollHeight}px tall in ${root.clientHeight}px)`);

    for (const image of document.images) {
      if (image.complete && image.naturalWidth === 0) issues.push(`broken image ${image.getAttribute("src")}`);
    }

    // Text cut off by an ellipsis or a fixed box, which the reader cannot recover.
    const clipped = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      if (!element.offsetParent || element.children.length > 0 || !element.textContent?.trim()) return false;
      const style = getComputedStyle(element);
      const hides = style.overflowX !== "visible" || style.textOverflow === "ellipsis";
      return hides && element.scrollWidth > element.clientWidth + 1;
    });
    for (const element of clipped.slice(0, 5)) issues.push(`clipped text "${element.textContent!.trim().slice(0, 40)}"`);
    return issues;
  }, shot.width >= 1024);
}

export async function checkArtifact(folderArg: string): Promise<void> {
  if (!(await exists(join(resolve(folderArg), "index.html")))) throw new Error(`${resolve(folderArg)} has no index.html`);
  const folder = await realpath(folderArg);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      // Serve only real files inside the folder: canonical paths stop both `..` and symlinks from reaching out.
      const requested = await realpath(join(folder, decodeURIComponent(new URL(request.url).pathname))).catch(() => null);
      if (!requested || (requested !== folder && !requested.startsWith(folder + sep))) return new Response("Not found", { status: 404 });

      const path = (await stat(requested)).isDirectory() ? join(requested, "index.html") : requested;
      return (await exists(path)) ? new Response(Bun.file(path)) : new Response("Not found", { status: 404 });
    },
  });

  const out = await mkdtemp(join(tmpdir(), `${basename(folder)}-check.`));
  const html = await readFile(join(folder, "index.html"), "utf8");
  const optionIds = [...(html.match(/<script id="options"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "").matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);

  const shots: Shot[] = [
    { name: "desktop", width: 1440, height: 900, scheme: "light" },
    { name: "mobile", width: 390, height: 844, scheme: "light" },
    { name: "mobile-dark", width: 390, height: 844, scheme: "dark" },
  ];
  // Options pages show one option at a time, so each option after the first needs its own desktop shot.
  for (const id of optionIds.slice(1)) {
    shots.push({ name: `desktop-${id}`, width: 1440, height: 900, scheme: "light", hash: id });
  }

  const browser = await chromium.launch({ channel: "chrome" });
  const problems: string[] = [];
  try {
    for (const shot of shots) {
      const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, colorScheme: shot.scheme, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`script error: ${error.message}`));
      page.on("requestfailed", (failed) => errors.push(`failed to load ${failed.url()} (${failed.failure()?.errorText})`));
      // Failed loads arrive twice, as a console error and a response; keep the response, which names the path.
      page.on("console", (message) => {
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`);
      });
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        // feedback.js probes these; they exist only once share-html publishes the page.
        if (response.status() >= 400 && !/\/feedback(-endpoint)?\.json$/.test(path)) errors.push(`${response.status()} ${path}`);
      });

      await page.goto(`http://127.0.0.1:${server.port}/${shot.hash ? `#${shot.hash}` : ""}`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(out, `${shot.name}.png`) });

      const issues = [...new Set([...errors, ...(await layoutIssues(page, shot))])];
      for (const issue of issues) problems.push(`${shot.name}: ${issue}`);
      await context.close();
    }
  } finally {
    await browser.close();
    server.stop(true);
  }

  // The same local-link and size rules share-html enforces when publishing.
  await assertPortable(await collectFiles(folder)).catch((error: Error) => problems.push(error.message));

  console.log(`Screenshots in ${out}:`);
  for (const shot of shots) console.log(`  ${join(out, `${shot.name}.png`)}`);
  console.log(problems.length ? `\n${problems.length} issue(s):\n${problems.map((p) => `  - ${p}`).join("\n")}` : "\nNo issues found.");
  if (problems.length) process.exitCode = 1;
}
