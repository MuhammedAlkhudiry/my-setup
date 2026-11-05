import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { localPathFor } from "../commands/share-html";
import { shareAccessProblem } from "./share-access";

const dir = await mkdtemp(join(tmpdir(), "share-access-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

async function tokenFile(expiresAt: string): Promise<string> {
  const path = join(dir, `${expiresAt}.json`);
  await writeFile(
    path,
    JSON.stringify({
      client_id: "id",
      client_secret: "secret",
      expires_at: expiresAt,
    }),
  );
  return path;
}

const respond = (status: number, location?: string) =>
  (async () =>
    new Response(null, {
      status,
      headers: location ? { location } : {},
    })) as unknown as typeof fetch;

describe("shareAccessProblem", () => {
  const now = Date.parse("2026-11-03T00:00:00Z");

  test("passes when Access lets the token through", async () => {
    const path = await tokenFile("2126-10-10T00:00:00Z");
    expect(await shareAccessProblem("share.example", path, respond(404), now)).toBeUndefined();
  });

  test("reports a redirect to the Access sign-in", async () => {
    const path = await tokenFile("2126-10-10T00:00:00Z");
    const problem = await shareAccessProblem(
      "share.example",
      path,
      respond(302, "https://team.cloudflareaccess.com/cdn-cgi/access/login"),
      now,
    );
    expect(problem).toContain("rejected the service token");
  });

  test("warns within 30 days of the token's expiry", async () => {
    const path = await tokenFile("2026-11-20T00:00:00Z");
    expect(await shareAccessProblem("share.example", path, respond(404), now)).toContain("expires");
  });

  test("reports a missing credential file", async () => {
    expect(await shareAccessProblem("share.example", join(dir, "none.json"))).toContain("missing");
  });
});

describe("localPathFor", () => {
  const prefix = "2026-11-03-demo-296b6627";
  const at = (path: string, host = "share.harium.app") => new URL(`https://${host}${path}`);

  test("maps the page's own files under the output folder", () => {
    expect(localPathFor(at(`/${prefix}/assets/app.css`), prefix, "/out")).toBe(
      "/out/assets/app.css",
    );
  });

  test("skips other pages, other hosts, and paths that climb out", () => {
    expect(
      localPathFor(at("/2026-11-02-other-00000000/index.html"), prefix, "/out"),
    ).toBeUndefined();
    expect(localPathFor(at(`/${prefix}/a.css`, "example.com"), prefix, "/out")).toBeUndefined();
    expect(localPathFor(at(`/${prefix}/%2e%2e/secret`), prefix, "/out")).toBeUndefined();
  });
});
