# Synthesizes cinematic effects (whooshes, risers, booms, shimmer, ambience, clock, room tone) with no
# tonal music content. Seeded, so every run writes identical files.
# usage: uv run --with numpy --with scipy --with soundfile sfx.py <out-dir>  -> <out-dir>/*.wav (48 kHz stereo)
import numpy as np, soundfile as sf, os, sys
from scipy import signal

SR = 48000
OUT = sys.argv[1] if len(sys.argv) > 1 else "sfx"
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)


def save(name, x):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    peak = np.max(np.abs(x)) or 1
    sf.write(f"{OUT}/{name}.wav", (x / peak * 0.89).astype(np.float32), SR)


def env(n, a, r, shape=2.0):
    t = np.linspace(0, 1, n)
    e = np.minimum(1, t / max(a, 1e-4)) * np.clip((1 - t) / max(r, 1e-4), 0, 1) ** shape
    return e


def bp_sweep(noise, f0, f1, q=2.0, steps=64):
    # time-varying bandpass by block processing
    out = np.zeros_like(noise)
    n = len(noise)
    blk = n // steps
    zi = None
    for i in range(steps):
        f = f0 * (f1 / f0) ** (i / (steps - 1))
        b, a = signal.iirpeak(min(f, SR / 2 - 100), q, SR)
        seg = noise[i * blk:(i + 1) * blk if i < steps - 1 else n]
        if zi is None:
            zi = signal.lfilter_zi(b, a) * 0
        y, zi = signal.lfilter(b, a, seg, zi=zi)
        out[i * blk:i * blk + len(y)] = y
    return out


def reverb(x, secs=1.8, mix=0.35, damp=6000):
    n = int(secs * SR)
    ir = rng.standard_normal(n) * np.exp(-np.linspace(0, 7, n))
    b, a = signal.butter(2, damp / (SR / 2))
    ir = signal.lfilter(b, a, ir)
    ir /= np.sqrt(np.sum(ir ** 2))
    wet = signal.fftconvolve(x, ir)
    dry = np.pad(x, (0, len(wet) - len(x)))
    return dry * (1 - mix) + wet * mix


def pan_stereo(x, p0, p1):
    p = np.linspace(p0, p1, len(x))
    l = np.cos((p + 1) * np.pi / 4)
    r = np.sin((p + 1) * np.pi / 4)
    return np.stack([x * l, x * r], 1)


# Whooshes: swept band-passed noise with a swelling envelope.
for name, dur, f0, f1, p0, p1 in [("whoosh_a", 0.7, 300, 2600, -0.7, 0.7), ("whoosh_b", 0.55, 2200, 400, 0.6, -0.6),
                                   ("whoosh_long", 1.3, 200, 3500, -0.4, 0.4), ("whoosh_soft", 0.9, 250, 1200, 0.3, -0.3)]:
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    e = np.sin(np.pi * t ** 0.8) ** 2.2
    x = bp_sweep(rng.standard_normal(n), f0, f1, q=1.4) * e
    x += signal.lfilter(*signal.butter(2, 180 / (SR / 2)), rng.standard_normal(n)) * e * 0.8
    save(name, pan_stereo(reverb(x, 0.8, 0.2), p0, p1))

# Riser: noise sweep + rising filtered swell, 2.2 s, ends abruptly (the hit covers it).
n = int(2.2 * SR)
t = np.linspace(0, 1, n)
e = t ** 2.4
x = bp_sweep(rng.standard_normal(n), 200, 7000, q=1.2, steps=128) * e
x += signal.lfilter(*signal.butter(2, [60 / (SR / 2), 400 / (SR / 2)], "band"), rng.standard_normal(n)) * e * 0.6
save("riser", pan_stereo(x, -0.2, 0.2))

# Impact boom: sub drop + transient + long tail.
n = int(3.0 * SR)
t = np.arange(n) / SR
f = 32 + 55 * np.exp(-t * 9)
sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.2)
click = rng.standard_normal(n) * np.exp(-t * 60)
click = signal.lfilter(*signal.butter(2, 3500 / (SR / 2)), click)
body = signal.lfilter(*signal.butter(2, 900 / (SR / 2)), rng.standard_normal(n)) * np.exp(-t * 5)
x = sub * 1.0 + click * 0.5 + body * 0.35
save("boom", reverb(x, 2.5, 0.3, 3000)[:n])

# Soft impact for UI slams (shorter, less sub).
n = int(1.2 * SR)
t = np.arange(n) / SR
f = 60 + 90 * np.exp(-t * 14)
x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6) + signal.lfilter(*signal.butter(2, 2500 / (SR / 2)), rng.standard_normal(n)) * np.exp(-t * 30) * 0.5
save("thump", reverb(x, 1.0, 0.2)[:n])

# Shimmer: dense random high partial grains (sparkle texture, not a melody).
def shimmer(dur, density, lo, hi, decay=18):
    # glitter made of short band-passed noise grains (no sustained pitch)
    n = int(dur * SR)
    x = np.zeros(n)
    for _ in range(int(density * dur)):
        s = rng.integers(0, int(n * 0.8))
        f = rng.uniform(lo, hi)
        m = int(SR * 0.06)
        b, a = signal.butter(2, [f / 1.5 / (SR / 2), min(f * 1.5, SR / 2 - 200) / (SR / 2)], "band")
        g = signal.lfilter(b, a, rng.standard_normal(m)) * np.exp(-np.arange(m) / SR * decay * 4) * rng.uniform(0.2, 1)
        x[s:s + m] += g[: n - s]
    e = np.minimum(1, np.linspace(0, 1, n) / 0.1) * np.linspace(1, 0.15, n)
    return reverb(x * e, 1.2, 0.35, 10000)

save("shimmer", np.stack([shimmer(1.6, 70, 2500, 9000), shimmer(1.6, 70, 2500, 9000)], 1))
save("sparkle_short", np.stack([shimmer(0.6, 60, 3000, 10000, 25), shimmer(0.6, 60, 3000, 10000, 25)], 1))

# Magic swell (companion appears): airy filtered noise swell + shimmer.
n = int(1.6 * SR)
t = np.linspace(0, 1, n)
air = bp_sweep(rng.standard_normal(n), 900, 5000, q=0.9) * np.sin(np.pi * t) ** 1.5
sh = shimmer(1.6, 40, 3000, 8000)[:n]
save("magic_swell", np.stack([air * 0.8 + sh * 0.6, air * 0.8 + sh * 0.6], 1))

# "World goes quiet": reverse swell that sucks in, then nothing.
n = int(1.4 * SR)
t = np.arange(n) / SR
x = reverb(signal.lfilter(*signal.butter(2, 1800 / (SR / 2)), rng.standard_normal(n)) * np.exp(-t * 4), 1.2, 0.5)[:n]
save("suck_in", x[::-1] * np.linspace(0, 1, n) ** 0.5)

# Ambience: fireplace crackle + room tone (30 s).
n = int(30 * SR)
room = signal.lfilter(*signal.butter(2, 250 / (SR / 2)), rng.standard_normal(n)) * 0.25
fire = signal.lfilter(*signal.butter(2, [300 / (SR / 2), 1500 / (SR / 2)], "band"), rng.standard_normal(n))
fire *= (0.5 + 0.5 * np.sin(np.cumsum(rng.uniform(0.5, 3, n)) / SR * 2 * np.pi)) * 0.12
crk = np.zeros(n)
for s in rng.integers(0, n - 2000, 900):
    m = rng.integers(80, 900)
    crk[s:s + m] += rng.standard_normal(m) * np.exp(-np.arange(m) / (m / 5)) * rng.uniform(0.1, 1) ** 2
crk = signal.lfilter(*signal.butter(2, 1200 / (SR / 2), "high"), crk) * 0.9
save("amb_fire", np.stack([room + fire + crk, room + fire + np.roll(crk, 700)], 1))

# Ambience: night air + distant crickets (30 s).
wind = signal.lfilter(*signal.butter(2, 500 / (SR / 2)), rng.standard_normal(n))
wind *= 0.6 + 0.4 * np.sin(2 * np.pi * np.arange(n) / SR * 0.13)
cr = np.zeros(n)
t = np.arange(n) / SR
for k in range(4):
    f = rng.uniform(4200, 5200)
    rate = rng.uniform(1.2, 2.2)
    gate = (np.sin(2 * np.pi * rate * t + k) > 0.6).astype(float)
    trill = (np.sin(2 * np.pi * 28 * t) > 0).astype(float)
    cr += np.sin(2 * np.pi * f * t) * signal.lfilter(*signal.butter(1, 60 / (SR / 2)), gate * trill) * rng.uniform(0.02, 0.05)
save("amb_night", np.stack([wind * 0.3, np.roll(wind, 5000) * 0.3], 1))

# Low heartbeat-like pulse for the quiet focus (soft, felt more than heard).
n = int(8 * SR)
x = np.zeros(n)
for s in np.arange(0, 8, 1.1):
    for d, g in ((0, 1), (0.22, 0.6)):
        i = int((s + d) * SR)
        m = int(0.25 * SR)
        tt = np.arange(m) / SR
        seg = np.sin(2 * np.pi * 48 * tt) * np.exp(-tt * 22) * g
        x[i:i + m] += seg[: n - i]
save("pulse", x)
print("ok", sorted(os.listdir(OUT)))

# Wooden clock tick / tock (noise click through a short damped body; no sustained pitch).
def tick(body_hz, n_ms=90):
    n = int(SR * n_ms / 1000)
    t = np.arange(n) / SR
    click = rng.standard_normal(n) * np.exp(-t * 900)
    b, a = signal.iirpeak(body_hz, 6, SR)
    body = signal.lfilter(b, a, rng.standard_normal(n) * np.exp(-t * 180))
    x = click * 0.6 + body * 1.2
    x = signal.lfilter(*signal.butter(2, [400 / (SR / 2), 6000 / (SR / 2)], "band"), x)
    return x
save("clock_tick", reverb(tick(1900), 0.4, 0.15))
save("clock_tock", reverb(tick(1500), 0.4, 0.15))

# Room tone: very soft air (brown-ish noise), glues the mix across cuts.
n = int(46 * SR)
brown = np.cumsum(rng.standard_normal(n))
brown = signal.lfilter(*signal.butter(1, 30 / (SR / 2), "high"), brown)
brown = signal.lfilter(*signal.butter(2, 900 / (SR / 2)), brown)
save("roomtone", np.stack([brown, np.roll(brown, 4000)], 1))
print("extra ok")
