/**
 * `filterImage`: downscale a source image to a target size with a preset.
 *
 * PROVISIONAL. This is carbon's own pipeline, written against the contract in
 * docs/IMAGES.md while the Genforge source could not be read (see
 * docs/build-notes/pixel.md, "Status"). The stages are the ones Genforge is
 * documented to have (halo fix, linear-light resampling, alpha cut, palette,
 * rim), but their exact maths are not Genforge's, so outputs are not
 * parity-verified. `report.provisional` says so to every caller.
 */
import { PixelError } from './errors';
import { resolveSettings } from './presets';
import { quantize } from './quantize';
import type { FilterOptions, FilterResult, RgbaImage, ResolvedPixelSettings } from './types';
import { PIXEL_PRESETS } from './types';

export const MAX_TARGET = 4096;

/** sRGB byte → linear light (0..1). */
const TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear light (0..1) → sRGB byte, rounded half up, clamped. */
export function linearToByte(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.floor(s * 255 + 0.5)));
}

export function srgbToLinear(byte: number): number {
  return TO_LINEAR[byte & 255] ?? 0;
}

/** Exact area coverage of source cells by each output cell along one axis. */
interface AxisWeights {
  start: Int32Array;
  count: Int32Array;
  idx: Int32Array;
  w: Float64Array;
  offset: Int32Array;
}

function axisWeights(src: number, dst: number): AxisWeights {
  const scale = src / dst;
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const offset = new Int32Array(dst);
  const idx: number[] = [];
  const w: number[] = [];
  for (let o = 0; o < dst; o++) {
    const a = o * scale;
    const b = (o + 1) * scale;
    const first = Math.floor(a);
    const last = Math.min(src - 1, Math.ceil(b) - 1);
    start[o] = first;
    offset[o] = idx.length;
    let n = 0;
    for (let s = first; s <= last; s++) {
      const cover = Math.min(b, s + 1) - Math.max(a, s);
      if (cover > 0) {
        idx.push(s);
        w.push(cover / scale);
        n++;
      }
    }
    count[o] = n;
  }
  return { start, count, idx: Int32Array.from(idx), w: Float64Array.from(w), offset };
}

function validate(src: RgbaImage, opts: FilterOptions): void {
  const { width, height, data } = src;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PixelError(`source size must be positive integers, got ${width}×${height}`);
  }
  if (data.length !== width * height * 4) {
    throw new PixelError(`source data has ${data.length} bytes, expected ${width * height * 4}`);
  }
  const { w, h } = opts.target;
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > MAX_TARGET ||
    h > MAX_TARGET
  ) {
    throw new PixelError(`target must be integers in 1..${MAX_TARGET}, got ${w}×${h}`);
  }
  if (!(PIXEL_PRESETS as readonly string[]).includes(opts.preset)) {
    throw new PixelError(`unknown preset "${opts.preset}"`);
  }
}

/** Area-average resample into straight RGBA8. */
function resample(
  src: RgbaImage,
  w: number,
  h: number,
  s: ResolvedPixelSettings,
): Uint8ClampedArray {
  const xs = axisWeights(src.width, w);
  const ys = axisWeights(src.height, h);
  const sd = src.data;
  const sw = src.width;
  const out = new Uint8ClampedArray(w * h * 4);
  const lin = s.linearLight;
  const premul = s.haloFix;
  for (let oy = 0; oy < h; oy++) {
    const yo = ys.offset[oy] ?? 0;
    const yn = ys.count[oy] ?? 0;
    for (let ox = 0; ox < w; ox++) {
      const xo = xs.offset[ox] ?? 0;
      const xn = xs.count[ox] ?? 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let j = 0; j < yn; j++) {
        const sy = ys.idx[yo + j] ?? 0;
        const wy = ys.w[yo + j] ?? 0;
        const row = sy * sw;
        for (let i = 0; i < xn; i++) {
          const sx = xs.idx[xo + i] ?? 0;
          const wt = wy * (xs.w[xo + i] ?? 0);
          const p = (row + sx) * 4;
          const pa = (sd[p + 3] ?? 0) / 255;
          // Halo fix: weight colour by alpha, so transparent pixels' (often black) RGB never bleeds in.
          const cw = premul ? wt * pa : wt;
          const pr = sd[p] ?? 0;
          const pg = sd[p + 1] ?? 0;
          const pb = sd[p + 2] ?? 0;
          r += cw * (lin ? srgbToLinear(pr) : pr / 255);
          g += cw * (lin ? srgbToLinear(pg) : pg / 255);
          b += cw * (lin ? srgbToLinear(pb) : pb / 255);
          a += wt * pa;
          wsum += cw;
        }
      }
      const q = (oy * w + ox) * 4;
      if (wsum > 0) {
        r /= wsum;
        g /= wsum;
        b /= wsum;
      }
      out[q] = lin ? linearToByte(r) : Math.floor(r * 255 + 0.5);
      out[q + 1] = lin ? linearToByte(g) : Math.floor(g * 255 + 0.5);
      out[q + 2] = lin ? linearToByte(b) : Math.floor(b * 255 + 0.5);
      out[q + 3] = s.tileable ? 255 : Math.floor(Math.min(1, a) * 255 + 0.5);
    }
  }
  return out;
}

function applyAlphaThreshold(d: Uint8ClampedArray, t: number): void {
  const cut = t * 255;
  for (let p = 3; p < d.length; p += 4) d[p] = (d[p] ?? 0) >= cut ? 255 : 0;
}

/** Darken opaque pixels that touch transparency or the image edge (4-neighbourhood). */
function applyRim(d: Uint8ClampedArray, w: number, h: number, amount: number): void {
  const alpha = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : (d[(y * w + x) * 4 + 3] ?? 0);
  const edge: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha(x, y) !== 255) continue;
      if (
        alpha(x - 1, y) < 255 ||
        alpha(x + 1, y) < 255 ||
        alpha(x, y - 1) < 255 ||
        alpha(x, y + 1) < 255
      ) {
        edge.push((y * w + x) * 4);
      }
    }
  }
  const k = 1 - amount;
  for (const p of edge) {
    for (let c = 0; c < 3; c++) d[p + c] = Math.floor((d[p + c] ?? 0) * k + 0.5);
  }
}

function countColors(d: Uint8ClampedArray): { colors: number; opaque: number } {
  const seen = new Set<number>();
  let opaque = 0;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] === 255) {
      opaque++;
      seen.add(((d[p] ?? 0) << 16) | ((d[p + 1] ?? 0) << 8) | (d[p + 2] ?? 0));
    }
  }
  return { colors: seen.size, opaque };
}

export function filterImage(src: RgbaImage, opts: FilterOptions): FilterResult {
  validate(src, opts);
  const settings = resolveSettings(opts.preset, opts.settings);
  const { w, h } = opts.target;
  const data = resample(src, w, h, settings);
  if (settings.alphaThreshold !== null) applyAlphaThreshold(data, settings.alphaThreshold);
  // The rim adds darker shades, so it runs before quantization keeps the palette bound.
  if (settings.rim > 0) applyRim(data, w, h, settings.rim);
  if (settings.paletteSize !== null) quantize(data, settings.paletteSize);
  // Fully transparent pixels carry no colour: canonical zeros keep outputs byte-stable.
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] === 0) data[p] = data[p + 1] = data[p + 2] = 0;
  }
  const { colors, opaque } = countColors(data);
  return {
    image: { width: w, height: h, data },
    report: {
      preset: opts.preset,
      settings,
      source: { w: src.width, h: src.height },
      target: { w, h },
      colors,
      opaquePixels: opaque,
      provisional: true,
      upstream: null,
    },
  };
}
