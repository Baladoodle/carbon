import { downscale, type Rgba } from './png';

/**
 * The pixel filters and icon sheets, behind pixel's API.
 *
 * ADAPTER: the pixel package ports Genforge to `src/core/pixel/` with
 * `filterImage(src, { target: { w, h }, preset }) → { image, report }`,
 * `sheetLayout`, `drawGuide` and `cropSheet` (branch
 * `claude/blissful-einstein-8u27ty-pixel`). Until it merges, these stand in
 * with the same names, signatures and result shapes, and simpler insides:
 *
 *  - `item`: crop to the opaque area, pad to a square, box-downscale, hard
 *    alpha and a 32-level colour quantise (no linear light, no palette)
 *  - `cropSheet`: alpha or flat-colour segmentation per cell, the bounding box
 *    padded to a square, and the four flags
 *
 * When pixel merges, this file becomes `export * from '@core/pixel'` (the
 * gateway imports only these names) and the gateway's tests keep passing.
 */

export type RgbaImage = Rgba;
export type PixelPreset = 'item' | 'sprite' | 'texture' | 'none';

export interface FilterOptions {
  target: { w: number; h: number };
  preset: PixelPreset;
  settings?: Record<string, unknown>;
}

export interface FilterResult {
  image: RgbaImage;
  report: {
    preset: PixelPreset;
    provisional: boolean;
    upstream: string | null;
    source: { w: number; h: number };
    target: { w: number; h: number };
  };
}

export const FILTER_SOURCE = 'images-core adapter (src/main/images/pixel.ts)';

const ALPHA_FG = 16;

/** The opaque bounding box (alpha ≥ 16), or the whole image when it's opaque everywhere or empty. */
function opaqueBox(img: Rgba): { x: number; y: number; w: number; h: number } {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if ((img.data[(y * img.width + x) * 4 + 3] as number) >= ALPHA_FG) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { x: 0, y: 0, w: img.width, h: img.height };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A square crop of `img` around `box`, transparent outside the image. */
function squareAround(
  img: Rgba,
  box: { x: number; y: number; w: number; h: number },
  pad = 0,
): Rgba {
  const side = Math.max(box.w, box.h) + pad * 2;
  const ox = box.x - Math.floor((side - box.w) / 2);
  const oy = box.y - Math.floor((side - box.h) / 2);
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const sx = ox + x;
      const sy = oy + y;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      const i = (sy * img.width + sx) * 4;
      out.set(img.data.subarray(i, i + 4), (y * side + x) * 4);
    }
  return { width: side, height: side, data: out };
}

export function filterImage(src: RgbaImage, opts: FilterOptions): FilterResult {
  const { w: tw, h: th } = opts.target;
  const report = {
    preset: opts.preset,
    provisional: true,
    upstream: null,
    source: { w: src.width, h: src.height },
    target: { w: tw, h: th },
  };
  if (opts.preset !== 'item' && opts.preset !== 'sprite')
    return { image: exact(downscale(src, Math.max(tw, th)), tw, th, false), report };
  const sq = squareAround(src, opaqueBox(src));
  return { image: exact(downscale(sq, Math.max(tw, th)), tw, th, true), report };
}

/** Nearest-samples `small` to exactly w×h; `hard` makes alpha 0/255 and quantises colour to 32 levels. */
function exact(small: Rgba, w: number, h: number, hard: boolean): Rgba {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(small.width - 1, Math.floor((x * small.width) / w));
      const sy = Math.min(small.height - 1, Math.floor((y * small.height) / h));
      const i = (sy * small.width + sx) * 4;
      const o = (y * w + x) * 4;
      if (!hard) {
        out.set(small.data.subarray(i, i + 4), o);
        continue;
      }
      const opaque = (small.data[i + 3] as number) >= 128;
      for (let c = 0; c < 3; c++)
        out[o + c] = opaque ? Math.round((small.data[i + c] as number) / 8) * 8 : 0;
      out[o + 3] = opaque ? 255 : 0;
    }
  return { width: w, height: h, data: out };
}

// ── icon sheets (IMAGES.md §2a) ─────────────────────────────────────────────

export const MAX_SHEET_ITEMS = 100;

export interface SheetCell {
  index: number;
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface SheetLayout {
  canvas: { w: number; h: number };
  cols: number;
  rows: number;
  gutter: number;
  cells: SheetCell[];
}

/** `n` items on a `canvas`: a near-square grid (10×10 at most), equal cells, equal gutters. */
export function sheetLayout(
  n: number,
  canvas: { w: number; h: number },
  opts: { cols?: number; rows?: number; gutter?: number } = {},
): SheetLayout {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SHEET_ITEMS)
    throw new Error(`a sheet holds 1..${MAX_SHEET_ITEMS} items, got ${n}`);
  const cols = opts.cols ?? Math.ceil(Math.sqrt(n));
  const rows = opts.rows ?? Math.ceil(n / cols);
  if (cols * rows < n) throw new Error(`a ${cols}×${rows} grid cannot hold ${n} items`);
  const gutter = opts.gutter ?? Math.max(1, Math.round(Math.min(canvas.w, canvas.h) * 0.02));
  const w = Math.floor((canvas.w - gutter * (cols + 1)) / cols);
  const h = Math.floor((canvas.h - gutter * (rows + 1)) / rows);
  if (w < 4 || h < 4) throw new Error(`cells would be ${w}×${h}: canvas too small`);
  const cells: SheetCell[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    cells.push({
      index: i,
      row,
      col,
      x: gutter + col * (w + gutter),
      y: gutter + row * (h + gutter),
      w,
      h,
    });
  }
  return { canvas: { ...canvas }, cols, rows, gutter, cells };
}

/** The guide image: a flat background with faint 1-px boxes around each cell. */
export function drawGuide(
  layout: SheetLayout,
  canvas: { w: number; h: number } = layout.canvas,
  opts: {
    background?: readonly [number, number, number];
    line?: readonly [number, number, number];
  } = {},
): RgbaImage {
  const [br, bg, bb] = opts.background ?? [255, 255, 255];
  const [lr, lg, lb] = opts.line ?? [220, 220, 220];
  const { w: W, h: H } = canvas;
  const sx = W / layout.canvas.w;
  const sy = H / layout.canvas.h;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < data.length; p += 4) data.set([br, bg, bb, 255], p);
  const put = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) data.set([lr, lg, lb, 255], (y * W + x) * 4);
  };
  for (const cell of layout.cells) {
    const c = {
      x: Math.round(cell.x * sx),
      y: Math.round(cell.y * sy),
      w: Math.round(cell.w * sx),
      h: Math.round(cell.h * sy),
    };
    for (let x = c.x - 1; x <= c.x + c.w; x++) {
      put(x, c.y - 1);
      put(x, c.y + c.h);
    }
    for (let y = c.y - 1; y <= c.y + c.h; y++) {
      put(c.x - 1, y);
      put(c.x + c.w, y);
    }
  }
  return { width: W, height: H, data };
}

export type CellFlag = 'empty' | 'background_only' | 'touches_edge' | 'fragmented';

export interface CroppedCell {
  index: number;
  region: { x: number; y: number; w: number; h: number };
  bbox: { x: number; y: number; w: number; h: number } | null;
  crop: RgbaImage | null;
  flags: CellFlag[];
  segmentation: 'alpha' | 'colour';
}

/** Cut a generated sheet into cells and find the sprite in each. */
export function cropSheet(
  sheet: RgbaImage,
  layout: SheetLayout,
  opts: { margin?: number; tolerance?: number; minFill?: number } = {},
): CroppedCell[] {
  const sx = sheet.width / layout.canvas.w;
  const sy = sheet.height / layout.canvas.h;
  const tol = opts.tolerance ?? 32;
  const minFill = opts.minFill ?? 0.005;
  let transparent = false;
  for (let i = 3; i < sheet.data.length; i += 4 * 97)
    if ((sheet.data[i] as number) < ALPHA_FG) {
      transparent = true;
      break;
    }
  return layout.cells.map((cell) => {
    const margin = Math.round((opts.margin ?? layout.gutter / 2) * Math.min(sx, sy));
    const x0 = Math.max(0, Math.round(cell.x * sx) - margin);
    const y0 = Math.max(0, Math.round(cell.y * sy) - margin);
    const x1 = Math.min(sheet.width, Math.round((cell.x + cell.w) * sx) + margin);
    const y1 = Math.min(sheet.height, Math.round((cell.y + cell.h) * sy) + margin);
    const region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const px = (x: number, y: number): number => (y * sheet.width + x) * 4;
    // The background: alpha, or the median colour of the region's border.
    let bgc: [number, number, number] = [0, 0, 0];
    if (!transparent) {
      const border: number[][] = [];
      for (let x = x0; x < x1; x++)
        for (const y of [y0, y1 - 1]) border.push([...sheet.data.subarray(px(x, y), px(x, y) + 3)]);
      for (let y = y0; y < y1; y++)
        for (const x of [x0, x1 - 1]) border.push([...sheet.data.subarray(px(x, y), px(x, y) + 3)]);
      bgc = [0, 1, 2].map((c) => {
        const v = border.map((b) => b[c] as number).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)] ?? 0;
      }) as [number, number, number];
    }
    const fg = (x: number, y: number): boolean => {
      const i = px(x, y);
      if ((sheet.data[i + 3] as number) < ALPHA_FG) return false;
      if (transparent) return true;
      return (
        Math.max(
          Math.abs((sheet.data[i] as number) - bgc[0]),
          Math.abs((sheet.data[i + 1] as number) - bgc[1]),
          Math.abs((sheet.data[i + 2] as number) - bgc[2]),
        ) > tol
      );
    };
    const mask = new Uint8Array(region.w * region.h);
    let count = 0;
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -1;
    let by1 = -1;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        if (fg(x, y)) {
          mask[(y - y0) * region.w + (x - x0)] = 1;
          count++;
          bx0 = Math.min(bx0, x);
          by0 = Math.min(by0, y);
          bx1 = Math.max(bx1, x);
          by1 = Math.max(by1, y);
        }
    const area = region.w * region.h;
    const flags: CellFlag[] = [];
    const segmentation = transparent ? ('alpha' as const) : ('colour' as const);
    if (count < area * minFill)
      return { index: cell.index, region, bbox: null, crop: null, flags: ['empty'], segmentation };
    if (count > area * 0.97) flags.push('background_only');
    if (bx0 <= x0 || by0 <= y0 || bx1 >= x1 - 1 || by1 >= y1 - 1) flags.push('touches_edge');
    // Large disconnected parts: count components holding ≥ 15% of the foreground.
    const seen = new Uint8Array(mask.length);
    let big = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || seen[i]) continue;
      let size = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length > 0) {
        const j = stack.pop() as number;
        size++;
        const x = j % region.w;
        const y = (j - x) / region.w;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= region.w || ny >= region.h) continue;
          const k = ny * region.w + nx;
          if (mask[k] && !seen[k]) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
      if (size >= count * 0.15) big++;
    }
    if (big > 1) flags.push('fragmented');
    const bbox = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
    // The sprite, background made transparent, padded to a square.
    const cut = new Uint8ClampedArray(bbox.w * bbox.h * 4);
    for (let y = 0; y < bbox.h; y++)
      for (let x = 0; x < bbox.w; x++) {
        const sxp = bbox.x + x;
        const syp = bbox.y + y;
        if (!mask[(syp - y0) * region.w + (sxp - x0)]) continue;
        cut.set(sheet.data.subarray(px(sxp, syp), px(sxp, syp) + 4), (y * bbox.w + x) * 4);
      }
    const crop = squareAround(
      { width: bbox.w, height: bbox.h, data: cut },
      { x: 0, y: 0, w: bbox.w, h: bbox.h },
    );
    return { index: cell.index, region, bbox, crop, flags, segmentation };
  });
}
