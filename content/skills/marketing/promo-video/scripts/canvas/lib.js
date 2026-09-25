// Starter helpers for a canvas film: timing, easing, springs, drawing primitives, Arabic text.
// Copy into the film and adapt the palette (C) and font families (AR, LATIN) to the brand.

export const W = 1080, H = 1920;
export const C = {
  bg: "#050608", surface: "#0F1115", primary: "#DC6646", secondary: "#F9B459", gold: "#FFD700",
  cream: "#FFF4DC", text: "#FFF0E5", soft: "#E6E1DD", muted: "#B6B0AC", ember: "#ffb08f",
  aura: "#F2B66D", flame: "#F29650", glow: "#FFD68C", lamp: "#FFBE64", fire: "#FF8232", spark: "#F2A93B",
  xp: "#DC8B73", coin: "#DEB476", border: "#BE9163", frost: "#EBF0FF",
};
export const AR = "Arabic"; // @font-face family for Arabic text
export const LATIN = "Latin"; // @font-face family for digits and Latin text

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const mix = (a, b, t) => a + (b - a) * clamp(t);

export const ease = {
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inQuint: (t) => t ** 5,
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
};

// Critically/under-damped spring step response: 0 -> 1 starting at time t0.
export function spring(t, t0, { freq = 2.2, damp = 0.45 } = {}) {
  // damping floor: at most one gentle overshoot, never a wobble
  damp = Math.max(damp, 0.62);
  const x = t - t0;
  if (x <= 0) return 0;
  const w = 2 * Math.PI * freq;
  const wd = w * Math.sqrt(1 - damp * damp);
  return 1 - Math.exp(-damp * w * x) * (Math.cos(wd * x) + ((damp * w) / wd) * Math.sin(wd * x));
}

// Deterministic PRNG.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
export const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
// Smooth 1D value noise.
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i + seed * 57.3), hash(i + 1 + seed * 57.3), u) * 2 - 1;
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("img " + src));
    img.src = src;
  });
}

// markup: inner SVG of a 24x24 icon; currentColor becomes `color`.
export function svgImage(markup, color, size = 96) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" color="${color}">${markup.replaceAll("currentColor", color)}</svg>`;
  return loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
}

export function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

export function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Soft radial glow (additive-looking).
export function glow(ctx, x, y, r, color, alpha = 1) {
  if (alpha <= 0 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  // gaussian-like falloff (no visible ring)
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (m) {
    const [r0, g0, b0, a0 = 1] = m[1].split(",").map(Number);
    for (const [k, f] of [[0, 1], [0.15, 0.78], [0.3, 0.5], [0.45, 0.28], [0.6, 0.13], [0.75, 0.05], [0.9, 0.012], [1, 0]]) g.addColorStop(k, `rgba(${r0},${g0},${b0},${a0 * f})`);
  } else {
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

export function rgba(hex, a) {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Arabic text. Never letter-space Arabic. `align` is visual: "center" | "right" | "left".
export function text(ctx, str, x, y, { size = 60, weight = 700, color = C.text, align = "center", alpha = 1, shadow = 0, shadowColor = "rgba(0,0,0,0.6)", font = AR, baseline = "middle", fill = null, stroke = 0, strokeColor = "rgba(0,0,0,0.5)" } = {}) {
  if (alpha <= 0) return 0;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.direction = font === AR ? "rtl" : "ltr";
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (shadow) {
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = shadow;
    ctx.shadowOffsetY = shadow * 0.25;
  }
  if (stroke) {
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke;
    ctx.strokeStyle = strokeColor;
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = fill ?? color;
  ctx.fillText(str, x, y);
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

export function measure(ctx, str, size, weight = 700, font = AR) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.direction = font === AR ? "rtl" : "ltr";
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

// Gold gradient fill for hero words.
export function goldFill(ctx, y, size) {
  const g = ctx.createLinearGradient(0, y - size * 0.6, 0, y + size * 0.6);
  g.addColorStop(0, "#FFF6E2");
  g.addColorStop(0.45, "#FFD68C");
  g.addColorStop(0.75, "#F2A93B");
  g.addColorStop(1, "#C9772F");
  return g;
}

// Draw an image covering the frame (object-fit: cover) with zoom/pan.
export function cover(ctx, img, { zoom = 1, px = 0.5, py = 0.5, alpha = 1, filter = "none", x = 0, y = 0, w = W, h = H } = {}) {
  if (alpha <= 0) return;
  const s = Math.max(w / img.width, h / img.height) * zoom;
  const dw = img.width * s, dh = img.height * s;
  const dx = x + (w - dw) * px, dy = y + (h - dh) * py;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.filter = filter;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

// Text whose digits keep a fixed advance, so counters and timers never shift as they change.
export function tabText(ctx, str, x, y, { size = 40, weight = 700, color = C.text, font = LATIN, align = "center", alpha = 1, shadow = 0 } = {}) {
  if (alpha <= 0) return;
  const dw = Math.max(...[..."0123456789"].map((d) => measure(ctx, d, size, weight, font)));
  const cells = [...str].map((ch) => (/[0-9]/.test(ch) ? dw : measure(ctx, ch, size, weight, font)));
  const total = cells.reduce((a, b) => a + b, 0);
  let cx = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  [...str].forEach((ch, i) => {
    text(ctx, ch, cx + cells[i] / 2, y, { size, weight, color, font, alpha, shadow, align: "center" });
    cx += cells[i];
  });
}

// One-time high-quality resample of a background to about its on-screen size (x overscan), so
// slow push-ins upsample gently instead of re-downsampling pixel art every frame (no shimmer).
export function prescale(img, overscan = 1.3) {
  const s = Math.max(W / img.width, H / img.height) * overscan;
  const c = canvas(Math.round(img.width * s), Math.round(img.height * s));
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function drawCentered(ctx, img, x, y, scale = 1, { alpha = 1, rot = 0, smooth = true } = {}) {
  if (alpha <= 0 || scale <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (-img.width * scale) / 2, (-img.height * scale) / 2, img.width * scale, img.height * scale);
  ctx.restore();
}

// Frosted dark card in the app's style: translucent warm-black, hairline border, soft shadow.
export function card(ctx, x, y, w, h, { r = 34, alpha = 1, fill = "rgba(16,12,10,0.82)", border = "rgba(255,226,190,0.14)", glowColor = null, glowAlpha = 0 } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  rrect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = "transparent";
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "rgba(255,240,220,0.07)");
  g.addColorStop(0.4, "rgba(255,240,220,0.0)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = border;
  ctx.stroke();
  if (glowColor && glowAlpha > 0) {
    ctx.globalAlpha *= glowAlpha;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 36;
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.restore();
}

export function pill(ctx, cx, cy, label, { size = 30, color = C.text, bg = "rgba(255,240,220,0.08)", border = "rgba(255,226,190,0.16)", padX = 22, h = null, alpha = 1, icon = null, iconSize = null, weight = 600 } = {}) {
  if (alpha <= 0) return 0;
  const tw = measure(ctx, label, size, weight);
  const is = icon ? iconSize ?? size * 1.05 : 0;
  const gap = icon ? size * 0.35 : 0;
  const w = tw + padX * 2 + is + gap;
  const hh = h ?? size * 1.75;
  ctx.save();
  ctx.globalAlpha *= alpha;
  rrect(ctx, cx - w / 2, cy - hh / 2, w, hh, hh / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = border;
  ctx.stroke();
  // RTL: icon on the right.
  const right = cx + w / 2 - padX;
  if (icon) ctx.drawImage(icon, right - is, cy - is / 2, is, is);
  text(ctx, label, right - is - gap, cy + size * 0.06, { size, weight, color, align: "right" });
  ctx.restore();
  return w;
}
