#!/usr/bin/env node
// Regenerates fixtures/pixel/sources/*.png deterministically (no randomness, no clock).
// Usage: node scripts/pixel-sources.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encode } from 'fast-png';

const out = resolve(process.argv[2] ?? 'fixtures/pixel/sources');
mkdirSync(out, { recursive: true });

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Draw with 4×4 supersampling: f(x, y) → [r, g, b, a] in 0..255 for continuous coords. */
function image(w, h, f, ss = 4) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const [pr, pg, pb, pa] = f(x + (i + 0.5) / ss, y + (j + 0.5) / ss);
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const o = (y * w + x) * 4;
      const n = ss * ss;
      data[o] = a ? clamp(r / a) : 0;
      data[o + 1] = a ? clamp(g / a) : 0;
      data[o + 2] = a ? clamp(b / a) : 0;
      data[o + 3] = clamp(a / n);
    }
  }
  return { width: w, height: h, data, channels: 4, depth: 8 };
}

const NONE = [0, 0, 0, 0];

/** Segment distance. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Integer hash noise (deterministic). */
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const sources = {
  // 1. A flat disc with an antialiased edge on transparency.
  'disc-256': image(256, 256, (x, y) =>
    Math.hypot(x - 128, y - 128) < 92 ? [214, 48, 49, 255] : NONE,
  ),
  // 2. An opaque two-axis gradient (texture-like).
  'gradient-256': image(256, 256, (x, y) => [x, y, 255 - (x + y) / 2, 255], 1),
  // 3. Hard checker with transparent holes.
  'checker-256': image(
    256,
    256,
    (x, y) => {
      const c = (Math.floor(x / 32) + Math.floor(y / 32)) % 3;
      return c === 0 ? NONE : c === 1 ? [30, 30, 40, 255] : [240, 220, 120, 255];
    },
    1,
  ),
  // 4. Soft radial alpha falloff (alpha-edge stress for the threshold).
  'softalpha-256': image(256, 256, (x, y) => {
    const d = Math.hypot(x - 128, y - 128);
    return [80 + d / 2, 160, 220 - d / 2, 255 * (1 - smooth(40, 120, d))];
  }),
  // 5. A sword icon: blade, guard, grip, pommel, dark outline.
  'sword-512': image(512, 512, (x, y) => {
    const blade = segDist(x, y, 190, 322, 430, 82);
    const guard = segDist(x, y, 140, 270, 240, 370);
    const grip = segDist(x, y, 190, 322, 110, 402);
    const pommel = Math.hypot(x - 100, y - 412);
    if (pommel < 22) return [200, 160, 40, 255];
    if (pommel < 28) return [30, 20, 20, 255];
    if (grip < 14) return [110, 60, 30, 255];
    if (grip < 20) return [30, 20, 20, 255];
    if (guard < 16) return [210, 170, 50, 255];
    if (guard < 22) return [30, 20, 20, 255];
    if (blade < 20) {
      const side = (x - 190) * 240 + (y - 322) * 240 > 0 ? 1 : 0;
      return side ? [225, 230, 240, 255] : [170, 180, 195, 255];
    }
    if (blade < 26) return [30, 20, 20, 255];
    return NONE;
  }),
  // 6. A potion: round flask, neck, cork, liquid gradient, highlight.
  'potion-512': image(512, 512, (x, y) => {
    const body = Math.hypot(x - 256, y - 320);
    const neck = Math.abs(x - 256) < 40 && y > 140 && y < 230;
    const cork = Math.abs(x - 256) < 48 && y > 100 && y <= 140;
    if (cork) return [150, 100, 60, 255];
    if (body < 140 || neck) {
      if (Math.hypot(x - 200, y - 270) < 28) return [255, 255, 255, 255];
      if (y > 300) return [60 + (y - 300) / 2, 30, 180 + (y - 300) / 4, 255];
      return [190, 220, 235, 140];
    }
    if (body < 150 || (Math.abs(x - 256) < 50 && y > 140 && y < 230)) return [40, 30, 50, 255];
    return NONE;
  }),
  // 7. Thin 1–3 px lines and a 1-px ring: topology stress (small features must survive or vanish predictably).
  'lines-256': image(256, 256, (x, y) => {
    if (Math.abs(Math.hypot(x - 128, y - 128) - 100) < 0.75) return [20, 200, 90, 255];
    for (let k = 0; k < 6; k++) {
      if (Math.abs(x - (30 + k * 38)) < 0.5 + k * 0.3 && y > 40 && y < 216)
        return [240, 240, 240, 255];
    }
    return NONE;
  }),
  // 9. A bow at provider resolution: a thick curved limb and a 2-px string, the case Genforge's
  //    `hairlines` stage exists for (the area average erases the string).
  'bow-1024': image(
    1024,
    1024,
    (x, y) => {
      const d = Math.hypot(x - 760, y - 512);
      const limb = Math.abs(d - 440) < 34 && x < 690;
      const tip = Math.abs(d - 440) < 44 && x < 690 && Math.abs(y - 512) > 380;
      if (tip) return [70, 40, 20, 255];
      if (limb) return [150 + (y % 64) / 4, 95, 45, 255];
      if (Math.abs(x - 540) < 1.2 && Math.abs(y - 512) < 392) return [235, 228, 205, 255];
      return NONE;
    },
    2,
  ),
  // 8. Non-square, opaque, seeded value noise (texture, odd scale factors).
  'noise-300x200': image(
    300,
    200,
    (x, y) => {
      const v = hash(Math.floor(x / 5), Math.floor(y / 5), 7);
      const u = hash(Math.floor(x), Math.floor(y), 11);
      return [60 + 120 * v, 90 + 80 * v + 20 * u, 40 + 40 * u, 255];
    },
    1,
  ),
};

for (const [name, img] of Object.entries(sources)) {
  writeFileSync(join(out, `${name}.png`), encode(img));
}
console.log(`wrote ${Object.keys(sources).length} sources to ${out}`);
