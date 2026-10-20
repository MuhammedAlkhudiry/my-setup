import { copyFile, mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { execa } from "execa";
import { chromium, type Page } from "playwright-core";

import { assertPortable, collectFiles, slugify } from "./share-html";

const ASSETS = resolve(import.meta.dir, "../../content/skills/workflow/html-artifacts/assets");
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

// Folder names follow `<project>-<topic>.XXXX`; a repo named `harium-project` is the `harium` project. A worktree's own folder name
// says nothing about the project, so read the name from the shared git directory.
async function projectName(root: string | null): Promise<string> {
  if (!root) return "page";
  const result = await execa("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
  });
  return slugify(basename(dirname(result.stdout.trim())).replace(/-project$/, ""));
}

export async function createArtifact(topic: string): Promise<void> {
  const root = await projectRoot(process.cwd());
  const folder = await mkdtemp(join(tmpdir(), `${await projectName(root)}-${slugify(topic)}.`));
  await copyFile(join(ASSETS, "feedback.js"), join(folder, "feedback.js"));

  console.log(process.argv.includes("--json") ? JSON.stringify({ folder }) : folder);
}

// --- check ---

interface Shot {
  name: string;
  width: number;
  height: number;
  scheme: "light" | "dark";
}

async function layoutIssues(page: Page, shot: Shot): Promise<string[]> {
  return page.evaluate((desktop) => {
    const issues: string[] = [];
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1)
      issues.push(`scrolls sideways (${root.scrollWidth}px wide in ${root.clientWidth}px)`);
    if (desktop && root.scrollHeight > root.clientHeight + 1)
      issues.push(`scrolls down (${root.scrollHeight}px tall in ${root.clientHeight}px)`);

    for (const image of document.images) {
      if (image.complete && image.naturalWidth === 0)
        issues.push(`broken image ${image.getAttribute("src")}`);
    }

    // Text cut off by an ellipsis or a fixed box, which the reader cannot recover.
    const clipped = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      if (!element.offsetParent || element.children.length > 0 || !element.textContent?.trim())
        return false;
      const style = getComputedStyle(element);
      const hides = style.overflowX !== "visible" || style.textOverflow === "ellipsis";
      return hides && element.scrollWidth > element.clientWidth + 1;
    });
    for (const element of clipped.slice(0, 5))
      issues.push(`clipped text "${element.textContent!.trim().slice(0, 40)}"`);
    return issues;
  }, shot.width >= 1024);
}

export async function checkArtifact(folderArg: string): Promise<void> {
  if (!(await exists(join(resolve(folderArg), "index.html"))))
    throw new Error(`${resolve(folderArg)} has no index.html`);
  const folder = await realpath(folderArg);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      // Serve only real files inside the folder: canonical paths stop both `..` and symlinks from reaching out.
      const inside = async (path: string) => {
        const real = await realpath(path).catch(() => null);
        return real && (real === folder || real.startsWith(folder + sep)) ? real : null;
      };

      let path = await inside(join(folder, decodeURIComponent(new URL(request.url).pathname)));
      if (path && (await stat(path)).isDirectory()) path = await inside(join(path, "index.html"));
      return path ? new Response(Bun.file(path)) : new Response("Not found", { status: 404 });
    },
  });

  const out = await mkdtemp(join(tmpdir(), `${basename(folder)}-check.`));
  const shots: Shot[] = [
    { name: "desktop", width: 1440, height: 900, scheme: "light" },
    { name: "mobile", width: 390, height: 844, scheme: "light" },
    { name: "mobile-dark", width: 390, height: 844, scheme: "dark" },
  ];

  const browser = await chromium.launch({ channel: "chrome" });
  const problems: string[] = [];
  try {
    for (const shot of shots) {
      const context = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        colorScheme: shot.scheme,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`script error: ${error.message}`));
      page.on("requestfailed", (failed) =>
        errors.push(`failed to load ${failed.url()} (${failed.failure()?.errorText})`),
      );
      // Failed loads arrive twice, as a console error and a response; keep the response, which names the path.
      page.on("console", (message) => {
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
          errors.push(`console: ${message.text()}`);
      });
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        // feedback.js probes these; they exist only once share-html publishes the page.
        if (response.status() >= 400 && !/\/feedback(-endpoint)?\.json$/.test(path))
          errors.push(`${response.status()} ${path}`);
      });

      await page.goto(`http://127.0.0.1:${server.port}/`, {
        waitUntil: "networkidle",
      });
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
  await assertPortable(await collectFiles(folder)).catch((error: Error) =>
    problems.push(error.message),
  );

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify({
        folder,
        screenshots: shots.map((shot) => join(out, `${shot.name}.png`)),
        problems,
      }),
    );
    if (problems.length) process.exitCode = 1;
    return;
  }
  console.log(`Screenshots in ${out}:`);
  for (const shot of shots) console.log(`  ${join(out, `${shot.name}.png`)}`);
  console.log(
    problems.length
      ? `\n${problems.length} issue(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`
      : "\nNo issues found.",
  );
  if (problems.length) process.exitCode = 1;
}
