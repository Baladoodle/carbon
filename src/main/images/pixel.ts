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
  const W = sheet.width;
  const H = sheet.height;
  const sx = W / layout.canvas.w;
  const sy = H / layout.canvas.h;
  const tol = opts.tolerance ?? 32;
  const minFill = opts.minFill ?? 0.005;
  const px = (x: number, y: number): number => (y * W + x) * 4;
  let transparent = false;
  for (let i = 3; i < sheet.data.length; i += 4 * 97)
    if ((sheet.data[i] as number) < ALPHA_FG) {
      transparent = true;
      break;
    }
  // A flat background: the median colour of the sheet's border.
  let bgc: [number, number, number] = [0, 0, 0];
  if (!transparent) {
    const border: number[][] = [];
    for (let x = 0; x < W; x++)
      for (const y of [0, H - 1]) border.push([...sheet.data.subarray(px(x, y), px(x, y) + 3)]);
    for (let y = 0; y < H; y++)
      for (const x of [0, W - 1]) border.push([...sheet.data.subarray(px(x, y), px(x, y) + 3)]);
    bgc = [0, 1, 2].map((c) => {
      const v = border.map((b) => b[c] as number).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)] ?? 0;
    }) as [number, number, number];
  }
  const fgAt = (i: number): boolean => {
    const o = i * 4;
    if ((sheet.data[o + 3] as number) < ALPHA_FG) return false;
    if (transparent) return true;
    return (
      Math.max(
        Math.abs((sheet.data[o] as number) - bgc[0]),
        Math.abs((sheet.data[o + 1] as number) - bgc[1]),
        Math.abs((sheet.data[o + 2] as number) - bgc[2]),
      ) > tol
    );
  };
  const segmentation = transparent ? ('alpha' as const) : ('colour' as const);

  // 1. Every connected part (4-neighbour) of the foreground, over the whole sheet.
  const label = new Int32Array(W * H).fill(-1);
  const parts: {
    size: number;
    sumX: number;
    sumY: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1 || !fgAt(start)) continue;
    const id = parts.length;
    const part = { size: 0, sumX: 0, sumY: 0, x0: W, y0: H, x1: -1, y1: -1 };
    parts.push(part);
    label[start] = id;
    stack.push(start);
    const visit = (k: number): void => {
      if (label[k] !== -1 || !fgAt(k)) return;
      label[k] = id;
      stack.push(k);
    };
    while (stack.length > 0) {
      const j = stack.pop() as number;
      const x = j % W;
      const y = (j - x) / W;
      part.size++;
      part.sumX += x;
      part.sumY += y;
      if (x < part.x0) part.x0 = x;
      if (x > part.x1) part.x1 = x;
      if (y < part.y0) part.y0 = y;
      if (y > part.y1) part.y1 = y;
      if (x > 0) visit(j - 1);
      if (x < W - 1) visit(j + 1);
      if (y > 0) visit(j - W);
      if (y < H - 1) visit(j + W);
    }
  }

  // 2. Each part belongs to the cell whose centre is nearest its centroid (the
  //    model keeps its own even grid, which drifts from ours by up to a gutter or more).
  const centres = layout.cells.map((c) => ({ x: (c.x + c.w / 2) * sx, y: (c.y + c.h / 2) * sy }));
  const owned: number[][] = layout.cells.map(() => []);
  const pitchX = (layout.cells[0]?.w ?? 1) * sx + layout.gutter * sx;
  const pitchY = (layout.cells[0]?.h ?? 1) * sy + layout.gutter * sy;
  parts.forEach((p, id) => {
    const mx = p.sumX / p.size;
    const my = p.sumY / p.size;
    let best = -1;
    let bestD = Infinity;
    centres.forEach((c, i) => {
      const d = ((mx - c.x) / pitchX) ** 2 + ((my - c.y) / pitchY) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    // Further than a whole cell from every centre: not part of any cell (stray marks).
    if (best >= 0 && bestD <= 1) owned[best]?.push(id);
  });

  // 3. Each cell's sprite: its parts' bounding box and size.
  const sprites = layout.cells.map((_cell, i) => {
    const ids = owned[i] ?? [];
    const count = ids.reduce((n, id) => n + (parts[id]?.size ?? 0), 0);
    if (ids.length === 0) return null;
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    for (const id of ids) {
      const p = parts[id];
      if (!p) continue;
      x0 = Math.min(x0, p.x0);
      y0 = Math.min(y0, p.y0);
      x1 = Math.max(x1, p.x1);
      y1 = Math.max(y1, p.y1);
    }
    return { ids, count, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
  });

  // 4. Register the grid: each row's and column's median offset of sprite centres.
  const median = (v: number[]): number => {
    if (v.length === 0) return 0;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  const rowOff = new Map<number, number>();
  const colOff = new Map<number, number>();
  for (let r = 0; r < layout.rows; r++)
    rowOff.set(
      r,
      median(
        layout.cells.flatMap((c, i) => {
          const s = sprites[i];
          return c.row === r && s ? [s.bbox.y + s.bbox.h / 2 - (centres[i]?.y ?? 0)] : [];
        }),
      ),
    );
  for (let k = 0; k < layout.cols; k++)
    colOff.set(
      k,
      median(
        layout.cells.flatMap((c, i) => {
          const s = sprites[i];
          return c.col === k && s ? [s.bbox.x + s.bbox.w / 2 - (centres[i]?.x ?? 0)] : [];
        }),
      ),
    );

  return layout.cells.map((cell, i) => {
    // The cell where the model actually drew it, plus half a gutter: past that, a sprite reaches toward a neighbour.
    const margin = Math.round(((opts.margin ?? layout.gutter / 2) * (sx + sy)) / 2);
    const dx = Math.round(colOff.get(cell.col) ?? 0);
    const dy = Math.round(rowOff.get(cell.row) ?? 0);
    const rx0 = Math.max(0, Math.round(cell.x * sx) + dx - margin);
    const ry0 = Math.max(0, Math.round(cell.y * sy) + dy - margin);
    const rx1 = Math.min(W, Math.round((cell.x + cell.w) * sx) + dx + margin);
    const ry1 = Math.min(H, Math.round((cell.y + cell.h) * sy) + dy + margin);
    const region = { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 };
    const s = sprites[i];
    const cellArea = cell.w * sx * cell.h * sy;
    if (!s || s.count < cellArea * minFill)
      return {
        index: cell.index,
        region,
        bbox: null,
        crop: null,
        flags: ['empty'] as CellFlag[],
        segmentation,
      };
    const flags: CellFlag[] = [];
    if (s.count > cellArea * 0.97) flags.push('background_only');
    const b = s.bbox;
    if (b.x < rx0 || b.y < ry0 || b.x + b.w > rx1 || b.y + b.h > ry1) flags.push('touches_edge');
    if (s.ids.filter((id) => (parts[id]?.size ?? 0) >= s.count * 0.15).length > 1)
      flags.push('fragmented');
    // The sprite (only its own parts; the rest transparent), padded to a square.
    const keep = new Set(s.ids);
    const cut = new Uint8ClampedArray(b.w * b.h * 4);
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++) {
        const j = (b.y + y) * W + (b.x + x);
        if (!keep.has(label[j] as number)) continue;
        cut.set(sheet.data.subarray(j * 4, j * 4 + 4), (y * b.w + x) * 4);
      }
    const crop = squareAround(
      { width: b.w, height: b.h, data: cut },
      { x: 0, y: 0, w: b.w, h: b.h },
    );
    return { index: cell.index, region, bbox: b, crop, flags, segmentation };
  });
}
