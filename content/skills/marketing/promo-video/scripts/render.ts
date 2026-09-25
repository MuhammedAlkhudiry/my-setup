// Renders a canvas film in headless Chrome (needs playwright-core in the film and Google Chrome installed).
//   bun render.ts frames <outDir> <t1,t2,...> --root <dir> --page <path> [--scale 0.5]
//   bun render.ts video <out.mkv> --root <dir> --page <path> [--fps 60] [--workers 8] [--from 0] [--to <dur>]
// --root is served over HTTP, so the page can read shared brand files in place; --page is relative to it.
// The page exposes window.FILM = { ready: Promise, duration: number, capture(t): base64 PNG } and must be a
// pure function of t: seeded randomness, no wall-clock time, no state carried between frames.
import { chromium, type Page } from "playwright-core";
import { $ } from "bun";
import { mkdirSync } from "fs";
import { resolve } from "path";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf("--" + k);
  if (i >= 0) return args[i + 1];
  if (d === undefined) throw new Error(`--${k} is required`);
  return d;
};
const mode = args[0];
const root = resolve(opt("root")) + "/";
const pagePath = opt("page").replace(/^\//, "");

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const f = Bun.file(root + decodeURIComponent(new URL(req.url).pathname));
    return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
  },
});
const url = `http://localhost:${server.port}/${pagePath}`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu-vsync", "--font-render-hinting=none"] });

async function openPage(): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 1 })).newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.error("[page]", m.text()); });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(url);
  await page.evaluate("window.FILM.ready");
  return page;
}
const grab = async (page: Page, t: number) => Buffer.from((await page.evaluate(`window.FILM.capture(${t})`)) as string, "base64");

try {
  if (mode === "frames") {
    const outDir = args[1];
    mkdirSync(outDir, { recursive: true });
    const page = await openPage();
    for (const t of args[2].split(",").map(Number)) {
      const name = `${outDir}/t${t.toFixed(2).padStart(6, "0")}.png`;
      await Bun.write(name, await grab(page, t));
      const scale = opt("scale", "");
      if (scale) await $`magick ${name} -resize ${Number(scale) * 100}% ${name}`.quiet();
      console.log(name);
    }
  } else if (mode === "video") {
    const out = resolve(args[1]);
    const fps = Number(opt("fps", "60"));
    const workers = Number(opt("workers", "8"));
    const probe = await openPage();
    const duration = (await probe.evaluate("window.FILM.duration")) as number;
    await probe.context().close();
    const f0 = Math.round(Number(opt("from", "0")) * fps), f1 = Math.round(Number(opt("to", String(duration))) * fps);
    const per = Math.ceil((f1 - f0) / workers);
    const chunkDir = `${out}.chunks`;
    mkdirSync(chunkDir, { recursive: true });
    const chunks: string[] = [];
    let done = 0;
    await Promise.all(Array.from({ length: workers }, async (_, w) => {
      const a = f0 + w * per, b = Math.min(f1, a + per);
      if (a >= b) return;
      const file = (chunks[w] = `${chunkDir}/c${String(w).padStart(2, "0")}.mkv`);
      const page = await openPage();
      // Near-lossless intermediate; encode the delivery file from it afterwards.
      const ff = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "8", "-pix_fmt", "yuv444p", file], { stdin: "pipe" });
      for (let f = a; f < b; f++) {
        ff.stdin.write(await grab(page, f / fps));
        await ff.stdin.flush();
        if (++done % 120 === 0) console.log(`${done}/${f1 - f0} frames`);
      }
      ff.stdin.end();
      await ff.exited;
      await page.context().close();
    }));
    await Bun.write(`${chunkDir}/list.txt`, chunks.filter(Boolean).map((c) => `file '${c}'`).join("\n"));
    await $`ffmpeg -y -loglevel error -f concat -safe 0 -i ${chunkDir}/list.txt -c copy ${out}`;
    await $`rm -r ${chunkDir}`;
    console.log("video:", out);
  } else {
    throw new Error("mode must be frames or video");
  }
} finally {
  await browser.close();
  server.stop();
}
