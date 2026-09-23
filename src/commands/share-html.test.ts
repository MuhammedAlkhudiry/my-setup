import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  artifactPrefix,
  findLocalOnlyReferences,
  findRelativeReferences,
  shareHtml,
  slugify,
} from "./share-html";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "my-setup-share-html-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("share-html", () => {
  test("slugify drops mktemp suffixes and HTML extensions", () => {
    expect(slugify("harium-ux-per-feature.MRYG")).toBe("harium-ux-per-feature");
    expect(slugify("Voice UI Options.html")).toBe("voice-ui-options");
    expect(slugify("المساعد")).toBe("artifact");
  });

  test("artifactPrefix is dated and unguessable", () => {
    const prefix = artifactPrefix("review", new Date("2026-09-23T10:00:00Z"));
    expect(prefix).toMatch(/^2026-09-23-review-[0-9a-f]{8}$/);
  });

  test("findLocalOnlyReferences flags links that only resolve on this Mac", () => {
    const html = `
      <a href="http://127.0.0.1:4189/pilot/index.html">rig</a>
      <img src="file:///var/folders/x/shot.png">
      <script>fetch("http://localhost:3000/data.json")</script>
      <a href="https://harium-main.test/login">app</a>
      <a href="https://github.com/org/repo/pull/1">PR</a>
      <p>Start the server on localhost:8080.</p>`;
    expect(findLocalOnlyReferences(html)).toEqual([
      "http://127.0.0.1:4189/pilot/index.html",
      "file:///var/folders/x/shot.png",
      "http://localhost:3000/data.json",
      "https://harium-main.test/login",
    ]);
  });

  test("findRelativeReferences ignores external, inline, and anchor links", () => {
    const html = `
      <img src="shots/a.png"><a href="#finding-1">1</a><a href="https://x.dev">x</a>
      <img src="data:image/png;base64,AAAA"><a href="mailto:a@b.c">m</a>
      <style>@font-face{src:url(fonts/Lama.woff2)}</style>`;
    expect(findRelativeReferences(html)).toEqual(["shots/a.png", "fonts/Lama.woff2"]);
  });

  test("dry run lists the folder files without dotfiles", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "shots"));
      await writeFile(join(dir, "index.html"), '<img src="shots/a.png">');
      await writeFile(join(dir, "shots", "a.png"), "png");
      await writeFile(join(dir, ".env"), "SECRET=1");

      const output: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => output.push(String(message));
      try {
        await shareHtml(dir, { dryRun: true, name: "demo" });
      } finally {
        console.log = originalLog;
      }

      expect(output[0]).toMatch(/^Would publish 2 files .* to https:\/\/share\.harium\.app\/.*-demo-/);
      expect(output.slice(1).map((line) => line.trim().split(" ")[0]).sort()).toEqual([
        "index.html",
        "shots/a.png",
      ]);
    });
  });

  test("rejects a folder without index.html and a single file with local assets", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "report.html"), '<img src="shot.png">');
      await expect(shareHtml(dir, { dryRun: true })).rejects.toThrow("no index.html");
      await expect(shareHtml(join(dir, "report.html"), { dryRun: true })).rejects.toThrow(
        "references local files",
      );
    });
  });

  test("rejects local-only links", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "index.html"), '<a href="http://localhost:5173/">app</a>');
      await expect(shareHtml(dir, { dryRun: true })).rejects.toThrow("only work on this Mac");
    });
  });
});
