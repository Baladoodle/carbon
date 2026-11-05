/**
 * Port of Genforge `genforge/filters/items.py`: the source-aware 16×16 item
 * converter (halo attenuation, tight alpha crop, linear-light premultiplied
 * Lanczos fit, unique-colour median cut, inward-anchored material rim) and
 * `hairlines`. Function names follow the Python; comments note where Python or
 * NumPy semantics are reproduced deliberately.
 */
import { SQUARE3, components8, dilate, ellipseKernel, open } from './cv';
import type { Mask } from './cv';
import { gaussianBlur, raster, resize } from './pil';
import type { Raster } from './pil';
import { fround, hsvToRgb, pyMod, rgbToHsv, roundHalfEven } from './py';

type RGB = readonly [number, number, number];

export const CANVAS = 16;
export const HALO_FLOOR = 0.1;
export const HALO_SOFT = 0.35;
export const BLUR = 0.4;
export const ALPHA_THRESHOLD = 64;
export const MATERIAL_COLORS = 16;
export const RIM_COLORS = 4;

function linearToSrgb(channel: number): number {
  const value = Math.max(0, Math.min(255, Math.trunc(channel))) / 255.0;
  const srgb = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, roundHalfEven(srgb * 255)));
}
const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, c) =>
  roundHalfEven(
    (c / 255.0 <= 0.04045 ? c / 255.0 / 12.92 : ((c / 255.0 + 0.055) / 1.055) ** 2.4) * 255,
  ),
);
const LINEAR_TO_SRGB = Array.from({ length: 256 }, (_, c) => linearToSrgb(c));

const clampChannel = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.min(255, roundHalfEven(v))) : 0;
const clampRgb = (c: readonly number[]): RGB => [
  clampChannel(c[0] ?? 0),
  clampChannel(c[1] ?? 0),
  clampChannel(c[2] ?? 0),
];
const key = (c: RGB): number => (c[0] << 16) | (c[1] << 8) | c[2];
const unkey = (k: number): RGB => [(k >> 16) & 255, (k >> 8) & 255, k & 255];

function colorSaturation(c: RGB): number {
  const [r, g, b] = c.map((v) => clampChannel(v) / 255.0) as [number, number, number];
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  return high > 1e-4 ? (high - low) / high : 0.0;
}
function hueChroma(c: RGB): [number, number] {
  const [r, g, b] = c.map((v) => clampChannel(v) / 255.0) as [number, number, number];
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const chroma = high - low;
  if (chroma <= 1e-4) return [0.0, 0.0];
  let hue: number;
  if (high === r) hue = pyMod((g - b) / chroma, 6.0);
  else if (high === g) hue = (b - r) / chroma + 2.0;
  else hue = (r - g) / chroma + 4.0;
  return [pyMod(hue / 6.0, 1.0), chroma];
}
function edgeColorsShareFamily(a: RGB, b: RGB): boolean {
  if (colorSaturation(a) < 0.15 && colorSaturation(b) < 0.15) return true;
  const diff = Math.abs(hueChroma(a)[0] - hueChroma(b)[0]);
  return Math.min(diff, 1.0 - diff) <= 0.14;
}

/** `_neighbors` (4-way, order: left, right, up, down). */
function neighbors(x: number, y: number, w: number, h: number): Array<[number, number]> {
  const r: Array<[number, number]> = [];
  if (x > 0) r.push([x - 1, y]);
  if (x + 1 < w) r.push([x + 1, y]);
  if (y > 0) r.push([x, y - 1]);
  if (y + 1 < h) r.push([x, y + 1]);
  return r;
}

function distanceTransform(mask: boolean[], w: number, h: number): number[] {
  const d = new Array<number>(w * h).fill(w + h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) d[p] = 0;
      else d[p] = Math.min(x > 0 ? (d[p - 1] ?? 0) : 0, y > 0 ? (d[p - w] ?? 0) : 0) + 1;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      if (mask[p]) {
        const right = x + 1 < w ? (d[p + 1] ?? 0) : 0;
        const down = y + 1 < h ? (d[p + w] ?? 0) : 0;
        d[p] = Math.min(d[p] ?? 0, Math.min(right, down) + 1);
      }
    }
  }
  return d;
}

function inwardAnchorColor(
  pos: number,
  colors: RGB[],
  mask: boolean[],
  dist: number[],
  w: number,
  h: number,
): [RGB, boolean] {
  const x = pos % w;
  const y = Math.floor(pos / w);
  let wx = 0.0;
  let wy = 0.0;
  let wt = 0.0;
  for (const radius of [1, 2]) {
    for (let ny = Math.max(0, y - radius); ny < Math.min(h, y + radius + 1); ny++) {
      for (let nx = Math.max(0, x - radius); nx < Math.min(w, x + radius + 1); nx++) {
        const p = ny * w + nx;
        if (mask[p] && (dist[p] ?? 0) >= 2) {
          const weight = dist[p] ?? 0;
          wx += (nx - x) * weight;
          wy += (ny - y) * weight;
          wt += weight;
        }
      }
    }
  }
  const self = colors[pos] ?? [0, 0, 0];
  if (!wt) return [self, false];
  const dx = wx / wt;
  const dy = wy / wt;
  const length = Math.max(0.001, Math.hypot(dx, dy));
  let samples: RGB[] = [];
  for (const depth of [2, 3, 4]) {
    const sx = roundHalfEven(x + (dx / length) * depth);
    const sy = roundHalfEven(y + (dy / length) * depth);
    if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
      const sp = sy * w + sx;
      if (mask[sp] && (dist[sp] ?? 0) >= 2) samples.push(colors[sp] ?? [0, 0, 0]);
    }
  }
  if (!samples.length) {
    samples = [];
    for (let ny = Math.max(0, y - 2); ny < Math.min(h, y + 3); ny++) {
      for (let nx = Math.max(0, x - 2); nx < Math.min(w, x + 3); nx++) {
        const p = ny * w + nx;
        if (mask[p] && (dist[p] ?? 0) >= 2) samples.push(colors[p] ?? [0, 0, 0]);
      }
    }
  }
  if (!samples.length) return [self, false];
  const med = (i: number): number =>
    samples.map((s) => s[i] ?? 0).sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
  return [[med(0), med(1), med(2)], true];
}

function makeBorderVariant(colors: RGB[]): RGB {
  if (!colors.length) return [8, 10, 16];
  let hx = 0.0;
  let hy = 0.0;
  let hw = 0.0;
  let tw = 0.0;
  let st = 0.0;
  let vt = 0.0;
  let maxV = 0.0;
  for (const raw of colors) {
    const c = clampRgb(raw);
    const [hue, sat, val] = rgbToHsv(c[0] / 255.0, c[1] / 255.0, c[2] / 255.0);
    const weight = Math.max(0.08, sat) * Math.max(0.12, val);
    if (sat >= 0.12) {
      hx += Math.cos(hue * 2 * Math.PI) * weight;
      hy += Math.sin(hue * 2 * Math.PI) * weight;
      hw += weight;
    }
    tw += weight;
    st += sat * weight;
    vt += val * weight;
    maxV = Math.max(maxV, val);
  }
  const hue = hw <= 0 ? 0.62 : pyMod(Math.atan2(hy, hx) / (2 * Math.PI), 1.0);
  let sat: number;
  let avgV: number;
  if (tw <= 0) {
    sat = 0.24;
    avgV = 0.5;
  } else {
    sat = st / tw;
    avgV = vt / tw;
  }
  sat = Math.max(0.18, Math.min(0.48, sat * 0.55));
  const value = Math.max(0.06, Math.min(0.22, Math.max(maxV * 0.3, avgV * 0.24)));
  return clampRgb(hsvToRgb(hue, sat, value).map((v) => v * 255.0));
}

function borderRimColor(representative: RGB, borderVariant: RGB, outlineDarken = 0.55): RGB {
  const rep = clampRgb(representative);
  const bv = clampRgb(borderVariant);
  let [hue, sat, val] = rgbToHsv(rep[0] / 255.0, rep[1] / 255.0, rep[2] / 255.0);
  const [bh, bs, bval] = rgbToHsv(bv[0] / 255.0, bv[1] / 255.0, bv[2] / 255.0);
  if (sat < 0.35) hue = bh;
  const darkenScale = Math.max(0.1, Math.min(2.0, outlineDarken / 0.55));
  sat = Math.min(0.72, Math.max(bs, sat * 0.85));
  val = Math.min(bval, val * 0.3 * darkenScale);
  return clampRgb(hsvToRgb(hue, sat, val).map((v) => v * 255.0));
}

function smoothOutlineColors(
  colors: Map<number, RGB>,
  boundary: Set<number>,
  w: number,
  h: number,
): Map<number, RGB> {
  const smoothed = new Map(colors);
  for (let pass = 0; pass < 2; pass++) {
    const changes = new Map<number, RGB>();
    for (const [pos, current] of smoothed) {
      const x = pos % w;
      const y = Math.floor(pos / w);
      // Counter insertion order (neighbour order) decides ties, as `most_common(1)` does.
      const counts = new Map<number, number>();
      for (const [nx, ny] of neighbors(x, y, w, h)) {
        const n = ny * w + nx;
        if (!boundary.has(n)) continue;
        const c = smoothed.get(n);
        if (c && edgeColorsShareFamily(current, c))
          counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
      }
      if (!counts.size) continue;
      let winner = -1;
      let count = -1;
      for (const [k, n] of counts) {
        if (n > count) {
          winner = k;
          count = n;
        }
      }
      if (winner !== key(current) && count >= 3 && count > (counts.get(key(current)) ?? 0) + 1) {
        changes.set(pos, unkey(winner));
      }
    }
    for (const [p, c] of changes) smoothed.set(p, c);
  }
  return smoothed;
}

/** `_median_cut_palette`: pixel-weighted median cut, deterministic ties as in Python. */
export function medianCutPalette(pixels: RGB[], requested: number): RGB[] {
  const counts = new Map<number, number>();
  for (const p of pixels) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  if (!counts.size) return [[0, 0, 0]];
  const entries: Array<[RGB, number]> = [...counts].map(([k, n]) => [unkey(k), n]);
  const target = Math.max(1, Math.min(requested, entries.length));
  const boxes: Array<Array<[RGB, number]>> = [entries];
  while (boxes.length < target) {
    let best: [number, number, number, number] | null = null;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index] ?? [];
      if (box.length < 2) continue;
      let r = 0;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (const [col] of box) {
          lo = Math.min(lo, col[c] ?? 0);
          hi = Math.max(hi, col[c] ?? 0);
        }
        r = Math.max(r, hi - lo);
      }
      const weight = box.reduce((s, [, n]) => s + n, 0);
      const cand: [number, number, number, number] = [r, weight, -index, index];
      if (
        !best ||
        cand[0] > best[0] ||
        (cand[0] === best[0] && (cand[1] > best[1] || (cand[1] === best[1] && cand[2] > best[2])))
      ) {
        best = cand;
      }
    }
    if (!best) break;
    const box = boxes.splice(best[3], 1)[0] ?? [];
    let channel = 0;
    let bestSpan = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 255;
      let hi = 0;
      for (const [col] of box) {
        lo = Math.min(lo, col[c] ?? 0);
        hi = Math.max(hi, col[c] ?? 0);
      }
      // max over (span, -c): the lowest channel wins ties.
      if (hi - lo > bestSpan) {
        bestSpan = hi - lo;
        channel = c;
      }
    }
    box.sort((a, b) => (a[0][channel] ?? 0) - (b[0][channel] ?? 0) || key(a[0]) - key(b[0]));
    const midpoint = box.reduce((s, [, n]) => s + n, 0) / 2;
    let running = 0;
    let split = 1;
    for (let i = 1; i < box.length; i++) {
      running += box[i - 1]?.[1] ?? 0;
      if (running >= midpoint) {
        split = i;
        break;
      }
    }
    boxes.push(box.slice(0, split), box.slice(split));
  }
  return boxes.map((box) => {
    const total = box.reduce((s, [, n]) => s + n, 0);
    const avg = [0, 1, 2].map((c) => box.reduce((s, [col, n]) => s + (col[c] ?? 0) * n, 0) / total);
    return clampRgb(avg);
  });
}

/** `halo_attenuate`: alpha → rint(clip((a/255 - floor) / (1 - floor), 0, 1) · 255), via a per-byte table. */
export function haloAttenuate(img: Raster, floor = HALO_FLOOR): Raster {
  const f = Math.max(0.0, Math.min(0.95, floor));
  const lut = new Uint8Array(256);
  for (let a = 0; a < 256; a++)
    lut[a] = roundHalfEven(Math.min(1.0, Math.max(0.0, (a / 255.0 - f) / (1.0 - f))) * 255.0);
  const out = { ...img, data: img.data.slice() };
  for (let p = 3; p < out.data.length; p += 4) out.data[p] = lut[img.data[p] as number] as number;
  return out;
}

/** `tight_alpha_crop`. */
export function tightAlphaCrop(img: Raster, threshold = 89): Raster {
  const b = alphaBounds(img, threshold);
  if (!b) return img;
  return crop(img, b[0], b[1], b[2], b[3]);
}

export function alphaBounds(
  img: Raster,
  threshold: number,
): [number, number, number, number] | null {
  let x0 = img.w;
  let y0 = img.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if ((img.data[(y * img.w + x) * 4 + 3] ?? 0) >= threshold) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

export function crop(img: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  const out = raster(x1 - x0, y1 - y0, img.c);
  for (let y = y0; y < y1; y++) {
    out.data.set(
      img.data.subarray((y * img.w + x0) * img.c, (y * img.w + x1) * img.c),
      (y - y0) * out.w * img.c,
    );
  }
  return out;
}

const channel = (img: Raster, c: number): Raster => {
  const out = raster(img.w, img.h, 1);
  for (let i = 0; i < img.w * img.h; i++) out.data[i] = img.data[i * 4 + c] ?? 0;
  return out;
};

/** `_premultiplied_resize` with LANCZOS. */
function premultipliedResize(img: Raster, w: number, h: number, blur: number): Raster {
  const srcAlpha = channel(img, 3);
  const alpha = blur > 0 ? gaussianBlur(srcAlpha, blur) : srcAlpha;
  const alphaSmall = resize(alpha, w, h, 'lanczos');
  const planes: Raster[] = [];
  for (let c = 0; c < 3; c++) {
    const plane = raster(img.w, img.h, 1);
    for (let i = 0; i < img.w * img.h; i++) {
      const lin = SRGB_TO_LINEAR[img.data[i * 4 + c] ?? 0] ?? 0;
      plane.data[i] = Math.min(255, Math.floor((lin * (srcAlpha.data[i] ?? 0) + 127) / 255));
    }
    planes.push(resize(blur > 0 ? gaussianBlur(plane, blur) : plane, w, h, 'lanczos'));
  }
  const out = raster(w, h, 4);
  for (let i = 0; i < w * h; i++) {
    const a = alphaSmall.data[i] ?? 0;
    for (let c = 0; c < 3; c++) {
      if (a !== 0) {
        const lin = roundHalfEven(((planes[c]?.data[i] ?? 0) * 255) / a);
        out.data[i * 4 + c] = LINEAR_TO_SRGB[Math.max(0, Math.min(255, lin))] ?? 0;
      }
    }
    out.data[i * 4 + 3] = a;
  }
  return out;
}

/** `fit_material` (scale_to_fit). */
export function fitMaterial(
  img: Raster,
  blur = BLUR,
  size = CANVAS,
): { reduced: Raster; offset: [number, number] } {
  const canvas = Math.max(1, Math.trunc(size));
  const scale = canvas / Math.max(img.w, img.h);
  const tw = Math.max(1, Math.min(canvas, roundHalfEven(img.w * scale)));
  const th = Math.max(1, Math.min(canvas, roundHalfEven(img.h * scale)));
  return {
    reduced: premultipliedResize(img, tw, th, blur),
    offset: [Math.floor((canvas - tw) / 2), Math.floor((canvas - th) / 2)],
  };
}

/** `quantize_material`. */
export function quantizeMaterial(
  reduced: Raster,
  offset: [number, number],
  alphaThreshold = ALPHA_THRESHOLD,
  materialColors = MATERIAL_COLORS,
  canvasSize = CANVAS,
): Raster {
  const canvas = Math.max(1, Math.trunc(canvasSize));
  const out = raster(canvas, canvas, 4);
  const n = reduced.w * reduced.h;
  const d = reduced.data;
  const seen = new Set<number>();
  const unique: RGB[] = [];
  for (let i = 0; i < n; i++) {
    if ((d[i * 4 + 3] ?? 0) < alphaThreshold) continue;
    const c: RGB = [d[i * 4] ?? 0, d[i * 4 + 1] ?? 0, d[i * 4 + 2] ?? 0];
    if (!seen.has(key(c))) {
      seen.add(key(c));
      unique.push(c);
    }
  }
  if (!unique.length) return out;
  const palette = medianCutPalette(
    unique,
    Math.min(Math.max(1, Math.trunc(materialColors)), unique.length),
  ).map(clampRgb);
  const [ox, oy] = offset;
  for (let y = 0; y < reduced.h; y++) {
    for (let x = 0; x < reduced.w; x++) {
      const i = y * reduced.w + x;
      const tx = ox + x;
      const ty = oy + y;
      if (tx < 0 || ty < 0 || tx >= canvas || ty >= canvas) continue;
      const q = (ty * canvas + tx) * 4;
      if ((d[i * 4 + 3] ?? 0) < alphaThreshold) continue; // RGB 0, alpha 0
      let best = 0;
      let bestD = Infinity;
      palette.forEach((p, pi) => {
        const dr = (d[i * 4] ?? 0) - p[0];
        const dg = (d[i * 4 + 1] ?? 0) - p[1];
        const db = (d[i * 4 + 2] ?? 0) - p[2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestD) {
          bestD = dist;
          best = pi;
        }
      });
      const p = palette[best] ?? [0, 0, 0];
      out.data[q] = p[0];
      out.data[q + 1] = p[1];
      out.data[q + 2] = p[2];
      out.data[q + 3] = 255;
    }
  }
  return out;
}

/** `apply_local_inner_rim`. */
export function applyLocalInnerRim(material: Raster, outlineDarken = 0.6): Raster {
  const out = { ...material, data: material.data.slice() };
  const { w, h } = out;
  const mask = Array.from({ length: w * h }, (_, i) => out.data[i * 4 + 3] === 255);
  if (!mask.some(Boolean)) return out;
  const dist = distanceTransform(mask, w, h);
  const boundary = new Set<number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      if (
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        neighbors(x, y, w, h).some(([nx, ny]) => !mask[ny * w + nx])
      ) {
        boundary.add(p);
      }
    }
  }
  if (!boundary.size) return out;
  const flat: RGB[] = Array.from({ length: w * h }, (_, i) => [
    out.data[i * 4] ?? 0,
    out.data[i * 4 + 1] ?? 0,
    out.data[i * 4 + 2] ?? 0,
  ]);
  const materialColors = flat.filter((_, i) => mask[i]);
  const med = (c: number): number => {
    const v = materialColors.map((m) => m[c] ?? 0).sort((a, b) => a - b);
    const n = v.length;
    const m = n % 2 ? (v[(n - 1) / 2] ?? 0) : ((v[n / 2 - 1] ?? 0) + (v[n / 2] ?? 0)) / 2;
    return roundHalfEven(m);
  };
  const fallback = clampRgb([med(0), med(1), med(2)]);
  const variant = clampRgb(makeBorderVariant(materialColors));
  // Boundary positions in ascending order: the result does not depend on set order (see notes).
  const positions = [...boundary].sort((a, b) => a - b);
  const outline = new Map<number, RGB>();
  for (const pos of positions) {
    const [anchor, reliable] = inwardAnchorColor(pos, flat, mask, dist, w, h);
    const rep = reliable ? anchor : mask[pos] ? (flat[pos] ?? fallback) : fallback;
    outline.set(pos, clampRgb(borderRimColor(rep, variant, outlineDarken)));
  }
  const values = [...outline.values()];
  const distinct = new Set(values.map(key)).size;
  const rim = medianCutPalette(values, Math.min(RIM_COLORS, distinct)).map(clampRgb);
  const snapped = new Map<number, RGB>();
  for (const [pos, c] of outline) {
    let best = 0;
    let bestD = Infinity;
    rim.forEach((r, i) => {
      const dist2 = (r[0] - c[0]) ** 2 + (r[1] - c[1]) ** 2 + (r[2] - c[2]) ** 2;
      if (dist2 < bestD) {
        bestD = dist2;
        best = i;
      }
    });
    snapped.set(pos, clampRgb(rim[best] ?? [0, 0, 0]));
  }
  for (const [pos, c] of smoothOutlineColors(snapped, boundary, w, h)) {
    out.data.set(c, pos * 4);
  }
  return out;
}

/** `hairlines`: redraw thin lines (bow strings, fishing line) the area average erases. */
export function hairlines(image: Raster, rendered: Raster, canvas = CANVAS): Raster {
  const openPx = 0.9;
  const minLength = 0.35;
  const minPixels = 60;
  const b = alphaBounds(haloAttenuate(image, HALO_FLOOR), roundHalfEven(HALO_SOFT * 255));
  if (!b) return rendered;
  const [x0, y0, x1, y1] = b;
  const width = x1 - x0;
  const height = y1 - y0;
  const scale = canvas / Math.max(width, height);
  const tw = Math.max(1, Math.min(canvas, roundHalfEven(width * scale)));
  const th = Math.max(1, Math.min(canvas, roundHalfEven(height * scale)));
  const offX = Math.floor((canvas - tw) / 2);
  const offY = Math.floor((canvas - th) / 2);
  const W = image.w;
  const H = image.h;
  const present: Mask = { w: W, h: H, data: new Uint8Array(W * H) };
  for (let i = 0; i < W * H; i++) present.data[i] = (image.data[i * 4 + 3] ?? 0) >= 40 ? 1 : 0;
  const radius = Math.max(2, Math.trunc(roundHalfEven(openPx / scale / 2)));
  const body = dilate(open(present, ellipseKernel(2 * radius + 1)), SQUARE3);
  const thin: Mask = { w: W, h: H, data: new Uint8Array(W * H) };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      thin.data[i] = present.data[i] && !body.data[i] ? 1 : 0;
    }
  }
  const keep = new Uint8Array(W * H);
  let kept = 0;
  for (const comp of components8(dilate(thin, SQUARE3))) {
    const length = Math.hypot(comp.width, comp.height);
    if (length >= minLength * Math.max(width, height) && comp.area <= 14 * length) {
      for (const p of comp.pixels) {
        if (thin.data[p] && !keep[p]) {
          keep[p] = 1;
          kept++;
        }
      }
    }
  }
  if (kept < minPixels) return rendered;
  const cells = new Map<number, number[]>();
  for (let i = 0; i < W * H; i++) {
    if (!keep[i]) continue;
    const tx = i % W;
    const ty = (i - tx) / W;
    const cx = Math.min(tw - 1, Math.max(0, Math.trunc(((tx - x0) * tw) / width))) + offX;
    const cy = Math.min(th - 1, Math.max(0, Math.trunc(((ty - y0) * th) / height))) + offY;
    const k = cy * canvas + cx;
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  }
  const out = { ...rendered, data: rendered.data.slice() };
  const L = [fround(0.299), fround(0.587), fround(0.114)] as const;
  // float32 `colors @ [0.299, 0.587, 0.114]`
  const luma = (i: number): number =>
    fround(
      fround(
        fround((image.data[i * 4] ?? 0) * L[0]) + fround((image.data[i * 4 + 1] ?? 0) * L[1]),
      ) + fround((image.data[i * 4 + 2] ?? 0) * L[2]),
    );
  for (const [k, members] of cells) {
    if ((out.data[k * 4 + 3] ?? 0) || members.length < 2) continue;
    const ranked = members
      .map((i, order) => ({ i, l: luma(i), order }))
      .sort((a, b) => b.l - a.l || a.order - b.order);
    const top = ranked.slice(0, Math.max(1, Math.floor(members.length / 10)));
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (const { i } of top) s = fround(s + (image.data[i * 4 + c] ?? 0));
      const mean = fround(s / top.length);
      out.data[k * 4 + c] = Math.trunc(Math.min(255, Math.max(0, mean)));
    }
    out.data[k * 4 + 3] = 255;
  }
  return out;
}

export interface ItemSettings {
  halo_floor?: number;
  crop_threshold?: number;
  blur?: number;
  alpha_threshold?: number;
  colors?: number | { count?: number; palette?: string[] };
  outline?: { darken?: number } | string;
  outline_darken?: number;
  hairlines?: boolean;
  before?: { blur?: number };
}

const hexRgb = (c: string): RGB => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
];

/** `render_item`: the item preset end to end. */
export function renderItem(
  src: Raster,
  size: [number, number],
  settings: ItemSettings = {},
  palette?: string[],
): Raster {
  const hFloor = settings.halo_floor ?? HALO_FLOOR;
  const cThresh = settings.crop_threshold ?? HALO_SOFT;
  const bVal = settings.blur ?? settings.before?.blur ?? BLUR;
  const aThresh = Math.trunc(settings.alpha_threshold ?? ALPHA_THRESHOLD);
  const cs = settings.colors;
  const mColors =
    typeof cs === 'number'
      ? cs
      : typeof cs === 'object'
        ? Math.trunc(cs.count ?? MATERIAL_COLORS)
        : MATERIAL_COLORS;
  const ov = settings.outline;
  const oDarken = typeof ov === 'object' ? (ov.darken ?? 0.55) : (settings.outline_darken ?? 0.55);
  const canvas = Math.max(size[0], size[1]);

  const cleaned = haloAttenuate(src, hFloor);
  const cropped = tightAlphaCrop(cleaned, roundHalfEven(cThresh * 255));
  const { reduced, offset } = fitMaterial(cropped, bVal, canvas);
  const material = quantizeMaterial(reduced, offset, aThresh, mColors, canvas);
  let rendered = applyLocalInnerRim(material, oDarken);
  if (settings.hairlines) rendered = hairlines(src, rendered, canvas);
  if (size[0] !== canvas || size[1] !== canvas) rendered = crop(rendered, 0, 0, size[0], size[1]);
  const pal = palette ?? (typeof cs === 'object' ? cs.palette : undefined);
  if (pal?.length) {
    const p = pal.map(hexRgb);
    const d = rendered.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!(d[i + 3] ?? 0)) continue;
      // float32 squared distances, first minimum wins (np.argmin)
      let best = 0;
      let bestD = Infinity;
      p.forEach((c, j) => {
        const dist = fround(
          fround(fround(((d[i] ?? 0) - c[0]) ** 2) + fround(((d[i + 1] ?? 0) - c[1]) ** 2)) +
            fround(((d[i + 2] ?? 0) - c[2]) ** 2),
        );
        if (dist < bestD) {
          bestD = dist;
          best = j;
        }
      });
      d.set(p[best] ?? [0, 0, 0], i);
    }
  }
  return rendered;
}
