// Mixes narration with timed effects: voice EQ and compression, effects ducked under the voice, loudness -14 LUFS.
//   bun mix.ts <narration.wav|flac> <cues.json> <duration-seconds> <out.wav>
// cues.json: [{ t, f, db, dur?, fi?, fo? }] — start second, file, gain in dB; a cue with `dur` is a bed trimmed
// to that length. Beds always crossfade over at least 0.4 s and one-shots get a 4 ms attack, so edges never click.
// Generate the cue list from the film's own timing module so sound and picture share one source of truth.
import { $ } from "bun";

type Cue = { t: number; f: string; db: number; dur?: number; fi?: number; fo?: number };
const [voice, cuesPath, durationArg, out] = process.argv.slice(2);
const cues: Cue[] = JSON.parse(await Bun.file(cuesPath).text());
const duration = Number(durationArg);

const inputs: string[] = [];
const chains = cues.map((c, i) => {
  inputs.push("-i", c.f);
  const delay = Math.max(0, Math.round(c.t * 1000));
  let ch = `[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo`;
  if (c.dur) ch += `,atrim=0:${c.dur.toFixed(3)},asetpts=PTS-STARTPTS`;
  const fi = c.dur ? Math.max(c.fi ?? 0, c.t < 0.05 ? 0.05 : 0.4) : Math.max(c.fi ?? 0, 0.004);
  ch += `,afade=t=in:d=${fi}`;
  if (c.dur) {
    const fo = Math.max(c.fo ?? 0, 0.4);
    ch += `,afade=t=out:st=${Math.max(0, c.dur - fo).toFixed(3)}:d=${fo}`;
  }
  return ch + `,volume=${c.db}dB,adelay=${delay}|${delay}[s${i}]`;
});
const graph = [
  `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=70,equalizer=f=220:t=q:w=1.2:g=-1.5,equalizer=f=3400:t=q:w=1.5:g=2.5,equalizer=f=9000:t=h:w=1:g=1.5,acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=3dB,asplit=2[vo][key]`,
  ...chains,
  `${cues.map((_, i) => `[s${i}]`).join("")}amix=inputs=${cues.length}:normalize=0:dropout_transition=0[sfx]`,
  `[sfx][key]sidechaincompress=threshold=0.04:ratio=4:attack=15:release=280:makeup=1[sfxd]`,
  `[vo][sfxd]amix=inputs=2:normalize=0,atrim=0:${duration},loudnorm=I=-14:TP=-1.5:LRA=11[out]`,
].join(";");
const graphFile = `${out}.graph.txt`;
await Bun.write(graphFile, graph);
await $`ffmpeg -y -loglevel error -i ${voice} ${inputs} -/filter_complex ${graphFile} -map [out] -ar 48000 -c:a pcm_s24le ${out}`;
await $`rm ${graphFile}`;
console.log("mixed", cues.length, "cues ->", out);
