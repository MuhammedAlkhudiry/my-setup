// Edit an image with an image model through OpenRouter (image in, image out).
//   bun image-edit.ts <model> <input.png|webp> <out.png> "<instruction>"
import { openRouterKey, logSpend } from "./openrouter";

const [model, input, out, instruction] = process.argv.slice(2);
const buf = Buffer.from(await Bun.file(input).arrayBuffer());
const mime = input.endsWith(".webp") ? "image/webp" : "image/png";
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${openRouterKey()}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    modalities: ["image", "text"],
    usage: { include: true },
    messages: [{ role: "user", content: [{ type: "text", text: instruction }, { type: "image_url", image_url: { url: `data:${mime};base64,${buf.toString("base64")}` } }] }],
  }),
});
const j = (await res.json()) as any;
if (!res.ok || j.error) throw new Error(JSON.stringify(j).slice(0, 1500));
const url = j.choices[0].message.images?.[0]?.image_url?.url;
if (!url) throw new Error("No image returned: " + JSON.stringify(j.choices[0].message).slice(0, 800));
await Bun.write(out, Buffer.from(url.split(",")[1], "base64"));
logSpend({ model, kind: "image-edit", cost: j.usage?.cost });
console.log("ok", out);
