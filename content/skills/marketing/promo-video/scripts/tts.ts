// Text to speech through OpenRouter. Always writes WAV: Gemini returns raw PCM (24 kHz s16le mono), others MP3.
//   bun tts.ts <model> <voice|-> <out.wav> <text> [providerOptionsJson]
import { $ } from "bun";
import { openRouterKey } from "./openrouter";

const [model, voice, out, text, opts] = process.argv.slice(2);
const pcm = model.startsWith("google/");
const body: Record<string, unknown> = { model, input: text, response_format: pcm ? "pcm" : "mp3" };
if (voice && voice !== "-") body.voice = voice;
if (opts) body.provider = { options: JSON.parse(opts) };
const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
  method: "POST",
  headers: { Authorization: `Bearer ${openRouterKey()}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const raw = out + (pcm ? ".pcm" : ".mp3");
await Bun.write(raw, await res.arrayBuffer());
if (pcm) await $`ffmpeg -y -loglevel error -f s16le -ar 24000 -ac 1 -i ${raw} ${out}`;
else await $`ffmpeg -y -loglevel error -i ${raw} ${out}`;
await $`rm ${raw}`;
console.log("ok", out, res.headers.get("x-generation-id"));
