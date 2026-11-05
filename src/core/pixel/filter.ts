/**
 * `filterImage`: Genforge's `filters.render(crop, size, settings)` in pure
 * TypeScript (port of genforge/filters/__init__.py; the item path is items.ts,
 * the topology path topology.ts, Pillow's resampling pil.ts). Parity with the
 * real Genforge is asserted by parity.test.ts against committed references.
 */
import { PixelError } from './errors';
import { renderItem } from './items';
import { resize } from './pil';
import type { Raster } from './pil';
import { PRESET_SETTINGS, UPSTREAM_REVISION } from './presets';
import { fround as F, roundHalfEven } from './py';
import {
  allocateAdaptivePalette,
  applyMaterialRim,
  contour,
  grammarMask,
  labelComponents,
  negativeSpace,
  poolSource,
} from './topology';
import type { FilterOptions, FilterResult, PixelSettings, RgbaImage } from './types';
import { PIXEL_PRESETS } from './types';

type RGB = readonly [number, number, number];

export const MAX_TARGET = 4096;
const DEFAULT_OUTLINE: RGB = [24, 32, 48];

const hex = (c: string): RGB => {
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new PixelError(`palette colours are #rrggbb, got "${c}"`);
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
};

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
  // genforge/cli.py: "The item preset requires a square target"
  if (opts.preset === 'item' && w !== h)
    throw new PixelError('the item preset requires a square target');
}

const UNSUPPORTED = ['before', 'vibrance', 'dither', 'noise'] as const;

const downscaleMode = (s: PixelSettings): string => s.downscale ?? 'edge_preserving';
const outlineMode = (s: PixelSettings): string =>
  typeof s.outline === 'object' ? (s.outline.mode ?? 'none') : (s.outline ?? 'none');
/** `_alpha_threshold`. */
const alphaThreshold = (a: unknown): number =>
  typeof a === 'number' ? Math.trunc(roundHalfEven(a * 255)) : 128;

function checkSettings(s: PixelSettings): void {
  const raw = s as Record<string, unknown>;
  for (const k of UNSUPPORTED) {
    if (raw[k] !== undefined && raw[k] !== null) {
      throw new PixelError(`setting "${k}" is not ported (docs/build-notes/pixel.md)`);
    }
  }
  const clean = raw['cleanup'] as Record<string, unknown> | undefined;
  if (clean?.['symmetry']) throw new PixelError('cleanup.symmetry is not ported');
  if (raw['alpha'] !== undefined && typeof raw['alpha'] !== 'number') {
    throw new PixelError('alpha must be a fraction (alpha: smooth is not ported)');
  }
  const mode = outlineMode(s);
  if (!['none', 'inner', 'hard', 'rim'].includes(mode))
    throw new PixelError(`outline "${mode}" is not ported`);
  const d = downscaleMode(s);
  if (!['item', 'source_aware', 'edge_preserving', 'area', 'nearest'].includes(d)) {
    throw new PixelError(`downscale "${d}" is not ported`);
  }
}

const toRaster = (img: RgbaImage): Raster => ({
  w: img.width,
  h: img.height,
  c: 4,
  data: new Uint8Array(img.data),
});

/** `_downscale` for edge_preserving / area / nearest: the mask and float32 materials on the grid. */
function downscale(
  img: Raster,
  grid: [number, number],
  s: PixelSettings,
): { mask: Uint8Array; materials: Float32Array } {
  const [gw, gh] = grid;
  const threshold = alphaThreshold(s.alpha);
  const n = gw * gh;
  const method = downscaleMode(s);
  if (method === 'edge_preserving') {
    const W = img.w;
    const H = img.h;
    const solid = new Uint8Array(W * H);
    let any = false;
    for (let i = 0; i < W * H; i++) {
      solid[i] = (img.data[i * 4 + 3] ?? 0) >= threshold ? 1 : 0;
      any ||= solid[i] === 1;
    }
    if (!any) return { mask: new Uint8Array(n), materials: new Float32Array(n * 3) };
    const { labels, components } = labelComponents(solid, W, H, true);
    const { holes, channels } = negativeSpace(solid, W, H);
    const P = poolSource(img.data, W, H, solid, labels, holes, channels, grid, false);
    const c = contour(solid, W, H);
    let perimeter = 0;
    let area = 0;
    for (let i = 0; i < W * H; i++) {
      perimeter += c[i] ?? 0;
      area += solid[i] ?? 0;
    }
    const softness = (4.0 * Math.PI * area) / Math.max(1.0, perimeter ** 2);
    return { mask: grammarMask(P, grid, components, softness), materials: P.material };
  }
  const small = resize(img, gw, gh, method === 'area' ? 'box' : 'nearest');
  const mask = new Uint8Array(n);
  const materials = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    mask[i] = (small.data[i * 4 + 3] ?? 0) >= threshold ? 1 : 0;
    for (let c = 0; c < 3; c++) materials[i * 3 + c] = small.data[i * 4 + c] ?? 0;
  }
  return { mask, materials };
}

/** `_palette`. */
function choosePalette(materials: Float32Array, mask: Uint8Array, s: PixelSettings): RGB[] {
  const colors = s.colors;
  const given = typeof colors === 'object' ? colors.palette : undefined;
  if (given?.length) return given.map(hex);
  const count = typeof colors === 'number' ? colors : (colors?.count ?? 16);
  const pick = typeof colors === 'object' ? (colors.pick ?? 'range') : 'range';
  if (!mask.some(Boolean)) return [DEFAULT_OUTLINE];
  return allocateAdaptivePalette(
    materials,
    mask,
    Math.min(4, count),
    count,
    pick === 'variance' ? 'variance' : 'range',
  );
}

/** float32 `((a - p) ** 2).sum(-1)` over 3 channels: NumPy's sequential sum from -0.0. */
function dist2f(a: readonly number[], p: RGB): number {
  const q = (x: number): number => F(x * x);
  return F(
    F(F(-0 + q(F((a[0] ?? 0) - p[0]))) + q(F((a[1] ?? 0) - p[1]))) + q(F((a[2] ?? 0) - p[2])),
  );
}

/** `np.argmin` over float32 distances: the first minimum wins. */
function nearestIndex(c: readonly number[], pal: RGB[]): number {
  let best = 0;
  let bestD = Infinity;
  pal.forEach((p, i) => {
    const d = dist2f(c, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** `_cleanup`: same-colour clusters smaller than `min_cluster` take their most common neighbour colour. */
function cleanup(
  px: Uint8Array,
  mask: Uint8Array,
  w: number,
  h: number,
  c: PixelSettings['cleanup'],
): Uint8Array {
  const minimum = Math.trunc(c?.min_cluster ?? (c?.stray ? 2 : 0));
  if (minimum < 2) return px;
  const key = (i: number): number =>
    ((px[i * 4] ?? 0) << 16) | ((px[i * 4 + 1] ?? 0) << 8) | (px[i * 4 + 2] ?? 0);
  const seen = new Uint8Array(w * h);
  const out = px.slice();
  const n4 = (i: number): number[] => {
    const x = i % w;
    const y = (i - x) / w;
    const r: number[] = [];
    if (y + 1 < h) r.push(i + w);
    if (y - 1 >= 0) r.push(i - w);
    if (x + 1 < w) r.push(i + 1);
    if (x - 1 >= 0) r.push(i - 1);
    return r;
  };
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    const k0 = key(s);
    const stack = [s];
    const cluster: number[] = [];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop() ?? 0;
      cluster.push(i);
      for (const n of n4(i)) {
        if (mask[n] && !seen[n] && key(n) === k0) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (cluster.length >= minimum) continue;
    const around = new Map<number, number>();
    for (const i of cluster) {
      for (const n of n4(i))
        if (mask[n] && key(n) !== k0) around.set(key(n), (around.get(key(n)) ?? 0) + 1);
    }
    if (!around.size) continue;
    // max(sorted(around), key=count): the smallest colour key among the most common
    let best = -1;
    let bestN = -1;
    for (const k of [...around.keys()].sort((a, b) => a - b)) {
      const cnt = around.get(k) ?? 0;
      if (cnt > bestN) {
        bestN = cnt;
        best = k;
      }
    }
    for (const i of cluster) out.set([(best >> 16) & 255, (best >> 8) & 255, best & 255], i * 4);
  }
  return out;
}

/** `run` → `_prepare` + `_finish` for the staged (non-item) downscales. */
function renderStaged(img: Raster, size: [number, number], s: PixelSettings): Raster {
  const [w, h] = size;
  const { mask, materials } = downscale(img, size, s);
  const colours = choosePalette(materials, mask, s);
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const m = [materials[i * 3] ?? 0, materials[i * 3 + 1] ?? 0, materials[i * 3 + 2] ?? 0];
    const c = colours[nearestIndex(m, colours)] ?? [0, 0, 0];
    out.set([c[0], c[1], c[2], 255], i * 4);
  }
  const mode = outlineMode(s);
  if (mode !== 'none' && mask.some(Boolean)) {
    const ov = typeof s.outline === 'object' ? s.outline : {};
    const cont = contour(mask, w, h);
    if (mode === 'hard') {
      const rgb =
        typeof ov.color === 'string' && ov.color.startsWith('#') ? hex(ov.color) : DEFAULT_OUTLINE;
      for (let i = 0; i < w * h; i++) if (cont[i]) out.set(rgb, i * 4);
    } else if (mode === 'inner') {
      const darken = F(ov.darken ?? 0.6);
      for (let i = 0; i < w * h; i++) {
        if (!cont[i]) continue;
        for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.trunc(F((out[i * 4 + c] ?? 0) * darken));
      }
    } else {
      applyMaterialRim(out, mask, cont, w, h, ov.darken ?? 0.6, 3, colours);
    }
  }
  let px = cleanup(out, mask, w, h, s.cleanup);
  const given = typeof s.colors === 'object' ? s.colors.palette : undefined;
  if (given?.length) {
    // a set palette is exact: outline shades snap back onto it
    px = px.slice();
    for (let i = 0; i < w * h; i++) {
      if (!(px[i * 4 + 3] ?? 0)) continue;
      const m = [px[i * 4] ?? 0, px[i * 4 + 1] ?? 0, px[i * 4 + 2] ?? 0];
      px.set(colours[nearestIndex(m, colours)] ?? [0, 0, 0], i * 4);
    }
  }
  return { w, h, c: 4, data: px };
}

/** `imaging.resample`: a copy, BOX when shrinking both axes, else NEAREST. */
function plainResample(img: Raster, w: number, h: number): Raster {
  if (img.w === w && img.h === h) return { ...img, data: img.data.slice() };
  return resize(img, w, h, w <= img.w && h <= img.h ? 'box' : 'nearest');
}

export function filterImage(src: RgbaImage, opts: FilterOptions): FilterResult {
  validate(src, opts);
  const settings = opts.settings ?? PRESET_SETTINGS[opts.preset];
  const { w, h } = opts.target;
  const img = toRaster(src);
  let out: Raster;
  if (settings === null) {
    out = plainResample(img, w, h);
  } else {
    checkSettings(settings);
    const d = downscaleMode(settings);
    out =
      d === 'item' || d === 'source_aware'
        ? renderItem(img, [w, h], settings)
        : renderStaged(img, [w, h], settings);
  }
  const data = new Uint8ClampedArray(out.data);
  const seen = new Set<number>();
  let opaque = 0;
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] === 255) {
      opaque++;
      seen.add(((data[p] ?? 0) << 16) | ((data[p + 1] ?? 0) << 8) | (data[p + 2] ?? 0));
    }
  }
  return {
    image: { width: w, height: h, data },
    report: {
      preset: opts.preset,
      settings: settings === null ? null : (JSON.parse(JSON.stringify(settings)) as PixelSettings),
      source: { w: src.width, h: src.height },
      target: { w, h },
      colors: seen.size,
      opaquePixels: opaque,
      upstream: UPSTREAM_REVISION,
    },
  };
}
