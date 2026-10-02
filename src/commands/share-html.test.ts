import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  artifactPrefix,
  findLocalOnlyReferences,
  findRelativeReferences,
  parseTemporaryCredentials,
  prefixFromRef,
  resolveWritablePage,
  shareHtml,
  slugify,
  withRetry,
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

      expect(output[0]).toMatch(
        /^Would publish 2 files .* to https:\/\/share\.harium\.app\/\d{4}-\d{2}-\d{2}-demo-<random>\/index\.html$/,
      );
      expect(
        output
          .slice(1)
          .map((line) => line.trim().split(" ")[0])
          .sort(),
      ).toEqual(["index.html", "shots/a.png"]);
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

  test("prefixFromRef accepts a share URL or a bare prefix", () => {
    const prefix = "2026-10-02-plan-review-v5-7e266e0a";
    expect(prefixFromRef(`https://share.harium.app/${prefix}/index.html`)).toBe(prefix);
    expect(prefixFromRef(prefix)).toBe(prefix);
    expect(prefixFromRef("plan review")).toBeUndefined();
  });

  test("resolveWritablePage prefers a direct ref, then the newest name match, then the newest page", () => {
    const pages = [
      { prefix: "2026-10-01-triage-aaaaaaaa", publishedAt: "2026-10-01T10:00:00Z" },
      { prefix: "2026-10-02-plan-review-bbbbbbbb", publishedAt: "2026-10-02T09:00:00Z" },
      { prefix: "2026-10-02-triage-cccccccc", publishedAt: "2026-10-02T11:00:00Z" },
    ];

    expect(resolveWritablePage(pages)).toBe("2026-10-02-triage-cccccccc");
    expect(resolveWritablePage(pages, "Plan Review")).toBe("2026-10-02-plan-review-bbbbbbbb");
    expect(resolveWritablePage(pages, "https://share.harium.app/2026-10-01-triage-aaaaaaaa/index.html")).toBe(
      "2026-10-01-triage-aaaaaaaa",
    );
    expect(resolveWritablePage(pages, "audit")).toBeUndefined();
    expect(resolveWritablePage([])).toBeUndefined();
  });

  test("parseTemporaryCredentials reads camelCase or snake_case inside any envelope", () => {
    expect(
      parseTemporaryCredentials('{"result":{"accessKeyId":"a","secretAccessKey":"s","sessionToken":"t"}}'),
    ).toEqual({ accessKeyId: "a", secretAccessKey: "s", sessionToken: "t" });
    expect(
      parseTemporaryCredentials('Created\n{"access_key_id":"a","secret_access_key":"s","session_token":"t"}'),
    ).toEqual({ accessKeyId: "a", secretAccessKey: "s", sessionToken: "t" });
    expect(() => parseTemporaryCredentials('{"result":{}}')).toThrow("no temporary credentials");
  });

  test("dry run of a writable page lists the feedback endpoint", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "index.html"), "<p>hi</p>");

      const output: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => output.push(String(message));
      try {
        await shareHtml(dir, { dryRun: true, writable: true });
      } finally {
        console.log = originalLog;
      }

      expect(output.at(-1)).toContain("feedback-endpoint.json");
    });
  });

  test("withRetry retries a failing upload and gives up after the last attempt", async () => {
    let calls = 0;
    const flaky = () => {
      calls++;
      return calls < 3 ? Promise.reject(new Error("timeout")) : Promise.resolve("ok");
    };

    expect(await withRetry(flaky, 3, () => 0)).toBe("ok");
    expect(calls).toBe(3);

    calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error("still down"));
    };

    expect(withRetry(failing, 2, () => 0)).rejects.toThrow("still down");
    await Bun.sleep(5);
    expect(calls).toBe(2);
  });
});
