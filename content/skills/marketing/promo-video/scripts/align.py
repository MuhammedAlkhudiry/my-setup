# Forced alignment of the narration take with torchaudio MMS_FA (CTC) + uroman romanization.
# Needs 16 kHz mono audio (ffmpeg -i take.wav -ar 16000 -ac 1 take.16k.wav). Writes [{w, rom, a, b, score}] in seconds.
# usage: uv run --with torch --with torchaudio --with soundfile --with uroman align.py <take.16k.wav> <script.txt> <out.json>
import sys, json, re, torch, torchaudio, soundfile as sf, uroman
wav_path, txt_path, out_path = sys.argv[1:4]
text = open(txt_path, encoding="utf8").read()
words = [w for w in re.split(r"\s+", re.sub(r"[.،,:!«»…]+", " ", text)) if w]
ur = uroman.Uroman()
bundle = torchaudio.pipelines.MMS_FA
model = bundle.get_model(with_star=False)
dictionary = bundle.get_dict(star=None)
audio, sr = sf.read(wav_path, dtype="float32")
wave = torch.tensor(audio).unsqueeze(0)
assert sr == bundle.sample_rate, sr
def norm(w):
    r = ur.romanize_string(w).lower()
    r = re.sub(r"[^a-z' ]", "", r.replace("'", "'"))
    return "".join(c for c in r if c in dictionary)
rom = [norm(w) for w in words]
tokens = [dictionary[c] for r in rom for c in r]
with torch.inference_mode():
    emission, _ = model(wave)
    aligned, scores = torchaudio.functional.forced_align(emission, torch.tensor([tokens], dtype=torch.int32))
spans = torchaudio.functional.merge_tokens(aligned[0], scores[0].exp())
ratio = wave.size(1) / emission.size(1) / sr
out, k = [], 0
for w, r in zip(words, rom):
    s = spans[k:k + len(r)]; k += len(r)
    out.append({"w": w, "rom": r, "a": round(s[0].start * ratio, 3), "b": round(s[-1].end * ratio, 3), "score": round(sum(x.score for x in s) / len(s), 3)})
json.dump(out, open(out_path, "w"), ensure_ascii=False, indent=0)
print(" | ".join(f"{o['a']:.2f}-{o['b']:.2f} {o['w']}" for o in out))
