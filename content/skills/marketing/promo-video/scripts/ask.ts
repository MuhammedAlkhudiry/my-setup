// Ask a model to review drafts: prompt plus audio (.wav/.mp3), video (.mp4), images, or text files.
//   bun ask.ts <model> <promptFile|-> [files...]
// Keep attachments small; a request of tens of MB can drop the connection.
import { openRouterKey, logSpend } from "./openrouter";

const [model, promptArg, ...files] = process.argv.slice(2);
const prompt = promptArg === "-" ? await Bun.stdin.text() : await Bun.file(promptArg).text();
const content: unknown[] = [{ type: "text", text: prompt }];
for (const f of files) {
  const buf = Buffer.from(await Bun.file(f).arrayBuffer());
  const ext = f.split(".").pop()!.toLowerCase();
  content.push({ type: "text", text: `--- ${f.split("/").pop()} ---` });
  if (ext === "wav" || ext === "mp3") content.push({ type: "input_audio", input_audio: { data: buf.toString("base64"), format: ext } });
  else if (ext === "mp4") content.push({ type: "video_url", video_url: { url: `data:video/mp4;base64,${buf.toString("base64")}` } });
  else if (["png", "jpg", "jpeg", "webp"].includes(ext))
    content.push({ type: "image_url", image_url: { url: `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${buf.toString("base64")}` } });
  else content.push({ type: "text", text: buf.toString("utf8") });
}
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${openRouterKey()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content }], usage: { include: true } }),
});
const j = (await res.json()) as any;
if (!res.ok || j.error) throw new Error(JSON.stringify(j).slice(0, 2000));
console.log(j.choices[0].message.content);
logSpend({ model, kind: "review", cost: j.usage?.cost, files: files.length });
