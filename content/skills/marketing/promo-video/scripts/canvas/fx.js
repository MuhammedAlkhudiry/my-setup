// Deterministic particle systems and post effects. Everything is a pure function of time.
import { W, H, clamp, lerp, hash, noise1, glow, canvas, rgba, ease } from "./lib.js";

// Warped clock for ambient motion: lets the world "go quiet" smoothly.
let warpTable = null;
export function buildWarp(duration, speedAt) {
  const dt = 1 / 240;
  const n = Math.ceil(duration / dt) + 2;
  warpTable = new Float64Array(n);
  for (let i = 1; i < n; i++) warpTable[i] = warpTable[i - 1] + speedAt(i * dt) * dt;
  warpTable.dt = dt;
}
export function warp(t) {
  if (!warpTable) return t;
  const f = t / warpTable.dt;
  const i = Math.max(0, Math.min(warpTable.length - 2, Math.floor(f)));
  return lerp(warpTable[i], warpTable[i + 1], f - i);
}

// Floating dust / bokeh motes.
export function dust(ctx, t, { count = 40, seed = 1, alpha = 1, color = "#FFD9A8", region = [0, 0, W, H], size = [2, 7], speed = 1, bokeh = 0.25 } = {}) {
  if (alpha <= 0) return;
  const [rx, ry, rw, rh] = region;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < count; i++) {
    const h1 = hash(i * 13.7 + seed), h2 = hash(i * 7.3 + seed * 3), h3 = hash(i * 3.1 + seed * 7), h4 = hash(i * 1.7 + seed * 11);
    const tt = t * speed * (0.3 + h3 * 0.7);
    const x = rx + ((h1 * rw + noise1(tt * 0.15 + i, seed) * 60 + tt * 8 * (h4 - 0.5)) % rw + rw) % rw;
    const y = ry + ((h2 * rh - tt * (6 + h4 * 16)) % rh + rh) % rh;
    const big = h4 < bokeh;
    const r = big ? lerp(10, 26, h3) : lerp(size[0], size[1], h3);
    const tw = 0.55 + 0.45 * Math.sin(tt * (1 + h1 * 2) + i);
    const a = alpha * tw * (big ? 0.12 : 0.55);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, a));
    g.addColorStop(big ? 0.7 : 0.35, rgba(color, a * (big ? 0.5 : 0.6)));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
}

// Rising embers from a source area.
export function embers(ctx, t, { x, y, spread = 120, count = 30, seed = 5, alpha = 1, height = 700, speed = 1 } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < count; i++) {
    const h1 = hash(i * 9.1 + seed), h2 = hash(i * 4.7 + seed), h3 = hash(i * 2.3 + seed);
    const life = 2.2 + h2 * 2.2;
    const age = ((t * speed + h1 * life) % life) / life;
    const px = x + (h3 - 0.5) * spread + noise1(age * 3 + i, seed) * 50 * age;
    const py = y - age * height * (0.6 + h2 * 0.6);
    const a = alpha * Math.sin(Math.PI * age) * (0.6 + 0.4 * Math.sin(t * 20 + i));
    const s = 3 + h1 * 3;
    ctx.fillStyle = rgba(age < 0.5 ? "#FFD08A" : "#FF8A3D", a);
    ctx.fillRect(Math.round(px), Math.round(py), s, s);
    glow(ctx, px, py, s * 5, rgba("#FF9A4A", 0.5), a * 0.5);
  }
  ctx.restore();
}

// Fireflies: soft cyan/gold dots wandering.
export function fireflies(ctx, t, { count = 26, seed = 3, alpha = 1, color = "#FFE08A", region = [0, 0, W, H] } = {}) {
  if (alpha <= 0) return;
  const [rx, ry, rw, rh] = region;
  for (let i = 0; i < count; i++) {
    const h1 = hash(i * 5.1 + seed), h2 = hash(i * 8.9 + seed);
    const x = rx + h1 * rw + noise1(t * 0.3 + i * 3, seed) * 70;
    const y = ry + h2 * rh + noise1(t * 0.25 + i * 7, seed + 1) * 70;
    const blink = clamp(Math.sin(t * (0.8 + h1) + i * 2.1) * 1.4 + 0.3);
    glow(ctx, x, y, 22, rgba(color, 0.9), alpha * blink * 0.6);
    ctx.save();
    ctx.globalAlpha = alpha * blink;
    ctx.fillStyle = "#FFF6D0";
    ctx.fillRect(x - 2, y - 2, 4, 4);
    ctx.restore();
  }
}

// Burst of pixel confetti / sparks from a point at time t0.
export function burst(ctx, t, t0, { x, y, count = 90, seed = 9, colors = ["#FFD68C", "#F9B459", "#DC6646", "#FFF4DC", "#8FD3FF"], power = 900, gravity = 900, life = 2.2, size = [6, 14], spin = true, alpha = 1 } = {}) {
  const dt = t - t0;
  if (dt < 0 || dt > life || alpha <= 0) return;
  ctx.save();
  for (let i = 0; i < count; i++) {
    const h1 = hash(i * 3.3 + seed), h2 = hash(i * 7.7 + seed), h3 = hash(i * 1.9 + seed), h4 = hash(i * 5.3 + seed);
    const ang = h1 * Math.PI * 2;
    const v = power * (0.35 + h2 * 0.65);
    const drag = 2.2;
    const k = (1 - Math.exp(-drag * dt)) / drag;
    const px = x + Math.cos(ang) * v * k;
    const py = y + Math.sin(ang) * v * k + 0.5 * gravity * dt * dt * (0.4 + h3 * 0.6);
    const s = lerp(size[0], size[1], h3);
    const a = alpha * (1 - clamp((dt - life * 0.55) / (life * 0.45)));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(px, py);
    if (spin) ctx.scale(Math.cos(dt * (6 + h4 * 10) + i), 1);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(-s / 2, -s / 2, s, s * (0.6 + h4 * 0.6));
    ctx.restore();
  }
  ctx.restore();
}

// Draw into a low-res layer and upscale with nearest neighbour, so effects share the pixel-art grain.
const layers = new Map();
export function pixelate(ctx, k, draw, op = "lighter") {
  if (!layers.has(k)) layers.set(k, canvas(Math.ceil(W / k), Math.ceil(H / k)));
  const c = layers.get(k);
  const g = c.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.clearRect(0, 0, c.width, c.height);
  g.setTransform(1 / k, 0, 0, 1 / k, 0, 0);
  draw(g);
  ctx.save();
  ctx.globalCompositeOperation = op;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, 0, 0, c.width * k, c.height * k);
  ctx.restore();
}

// Radial god rays.
export function rays(ctx, x, y, opts = {}) {
  if ((opts.alpha ?? 1) <= 0) return;
  pixelate(ctx, 8, (g) => raysRaw(g, x, y, { spin: 0.06, ...opts }));
}
function raysRaw(ctx, x, y, { t = 0, count = 14, alpha = 1, color = "#FFD68C", len = 1400, width = 0.12, spin = 0.15 } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * spin);
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, len);
  g.addColorStop(0, rgba(color, 0.55 * alpha));
  g.addColorStop(0.4, rgba(color, 0.18 * alpha));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const w = width * (0.6 + 0.8 * hash(i + 4));
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, len, a - w / 2, a + w / 2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// Expanding shock ring.
export function ring(ctx, t, t0, o) {
  const p = (t - t0) / (o.life ?? 0.8);
  if (p < 0 || p > 1) return;
  pixelate(ctx, 4, (g) => ringRaw(g, t, t0, o));
}
function ringRaw(ctx, t, t0, { x, y, r0 = 40, r1 = 600, life = 0.8, color = "#FFE3AE", width = 10, alpha = 1 } = {}) {
  const p = (t - t0) / life;
  const e = ease.outQuint(p);
  ctx.save();
  ctx.globalAlpha = alpha * (1 - p) ** 1.5;
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(8, width * (1 - p * 0.7));
  ctx.beginPath();
  ctx.arc(x, y, lerp(r0, r1, e), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Sparkle star (4-point) glint.
export function glint(ctx, x, y, size, alpha = 1, rot = 0, color = "#FFF6E2") {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(alpha);
  glow(ctx, x, y, size * 1.6, "rgba(255,214,140,0.7)", 0.6);
  // pixel-art 4-point sparkle on a pixel grid; arms pulse with rot
  const p = Math.max(4, Math.round(size / 6));
  const arm = Math.max(2, Math.round((size / p) * (0.75 + 0.25 * Math.sin(rot * 2))));
  const cx = x, cy = y; // sub-pixel: moving sparkles glide instead of stepping
  ctx.fillStyle = color;
  ctx.fillRect(cx - p, cy - p, p * 2, p * 2);
  for (let i = 1; i <= arm; i++) {
    const w = i > arm * 0.6 ? p : p * 1;
    ctx.globalAlpha = clamp(alpha) * (1 - (i / (arm + 1)) * 0.55);
    ctx.fillRect(cx - p / 2 + p * i, cy - p / 2, w, p);
    ctx.fillRect(cx - p / 2 - p * i, cy - p / 2, w, p);
    ctx.fillRect(cx - p / 2, cy - p / 2 + p * i, p, w);
    ctx.fillRect(cx - p / 2, cy - p / 2 - p * i, p, w);
  }
  ctx.restore();
}

// Post: vignette + grain + letterbox-safe finishing.
let grainTiles = null;
export function initGrain() {
  grainTiles = [];
  for (let k = 0; k < 8; k++) {
    const c = canvas(540, 960);
    const g = c.getContext("2d");
    const img = g.createImageData(540, 960);
    let s = (k + 1) * 99991;
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) >>> 0;
      const v = 128 + ((s >>> 16) % 90) - 45;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainTiles.push(c);
  }
}
export function vignette(ctx, strength = 0.6, inner = 0.45) {
  const g = ctx.createRadialGradient(W / 2, H * 0.48, H * inner * 0.5, W / 2, H * 0.48, H * 0.78);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(3,2,2,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
export function grain(ctx, t, amount = 0.05) {
  const tile = grainTiles[Math.floor(t * 24) % grainTiles.length];
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.globalCompositeOperation = "overlay";
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tile, 0, 0, W, H);
  ctx.restore();
}
