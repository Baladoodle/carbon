/**
 * Icon sheets (docs/IMAGES.md §2a): lay N items out on one canvas, draw the
 * guide image, and crop the generated sheet back into one sprite per cell with
 * flags for review. Pure and deterministic.
 */
import { PixelError } from './errors';
import type { RgbaImage } from './types';

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

export interface LayoutOptions {
  cols?: number;
  rows?: number;
  /** Pixels between cells and around the edge. Default: 2% of the shorter side. */
  gutter?: number;
}

/** `n` items on a `canvas`: a near-square grid (10×10 at most), equal cells, equal gutters. */
export function sheetLayout(
  n: number,
  canvas: { w: number; h: number },
  opts: LayoutOptions = {},
): SheetLayout {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SHEET_ITEMS) {
    throw new PixelError(`a sheet holds 1..${MAX_SHEET_ITEMS} items, got ${n}`);
  }
  const cols = opts.cols ?? Math.ceil(Math.sqrt(n));
  const rows = opts.rows ?? Math.ceil(n / cols);
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols * rows < n
  ) {
    throw new PixelError(`a ${cols}×${rows} grid cannot hold ${n} items`);
  }
  const gutter = opts.gutter ?? Math.max(1, Math.round(Math.min(canvas.w, canvas.h) * 0.02));
  const w = Math.floor((canvas.w - gutter * (cols + 1)) / cols);
  const h = Math.floor((canvas.h - gutter * (rows + 1)) / rows);
  if (w < 4 || h < 4) throw new PixelError(`cells would be ${w}×${h}: canvas too small`);
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

export interface GuideOptions {
  background?: readonly [number, number, number];
  line?: readonly [number, number, number];
}

/** The guide image: a flat background with faint 1-px boxes around each cell. */
export function sheetGuide(layout: SheetLayout, opts: GuideOptions = {}): RgbaImage {
  const [br, bg, bb] = opts.background ?? [255, 255, 255];
  const [lr, lg, lb] = opts.line ?? [220, 220, 220];
  const { w: W, h: H } = layout.canvas;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < data.length; p += 4) data.set([br, bg, bb, 255], p);
  const put = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) data.set([lr, lg, lb, 255], (y * W + x) * 4);
  };
  for (const c of layout.cells) {
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

export type CellFlag = 'empty' | 'uniform' | 'touches-edge' | 'fragmented';

export interface CropOptions {
  /** Pixels added around each cell, into the gutter. Default: half the gutter. */
  margin?: number;
  /** Max channel distance from the background colour that still counts as background. Default 32. */
  tolerance?: number;
  /** Foreground below this fraction of the cell area is "empty". Default 0.005. */
  minFill?: number;
}

export interface CroppedCell {
  index: number;
  /** The region cut from the sheet (cell plus margin), in sheet coordinates. */
  region: { x: number; y: number; w: number; h: number };
  /** The sprite's bounding box, in sheet coordinates, or null when nothing was found. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** The sprite padded to a square; background pixels are transparent. Null when empty. */
  crop: RgbaImage | null;
  flags: CellFlag[];
  /** How the background was found. */
  segmentation: 'alpha' | 'colour';
}

/** Cut a generated sheet into cells and find the sprite in each. */
export function cropSheet(
  sheet: RgbaImage,
  layout: SheetLayout,
  opts: CropOptions = {},
): CroppedCell[] {
  if (sheet.data.length !== sheet.width * sheet.height * 4) {
    throw new PixelError(
      `sheet data has ${sheet.data.length} bytes, expected ${sheet.width * sheet.height * 4}`,
    );
  }
  // The model may return a different size than requested: scale the grid to the sheet.
  const sx = sheet.width / layout.canvas.w;
  const sy = sheet.height / layout.canvas.h;
  const margin = opts.margin ?? Math.floor(layout.gutter / 2);
  const tolerance = opts.tolerance ?? 32;
  const minFill = opts.minFill ?? 0.005;
  const d = sheet.data;
  let hasAlpha = false;
  for (let p = 3; p < d.length; p += 4) {
    if ((d[p] ?? 255) < 255) {
      hasAlpha = true;
      break;
    }
  }
  return layout.cells.map((cell) => {
    const x0 = Math.max(0, Math.floor((cell.x - margin) * sx));
    const y0 = Math.max(0, Math.floor((cell.y - margin) * sy));
    const x1 = Math.min(sheet.width, Math.ceil((cell.x + cell.w + margin) * sx));
    const y1 = Math.min(sheet.height, Math.ceil((cell.y + cell.h + margin) * sy));
    const rw = x1 - x0;
    const rh = y1 - y0;
    const at = (x: number, y: number): number => ((y0 + y) * sheet.width + x0 + x) * 4;
    const bgColour = hasAlpha ? null : borderColour(d, at, rw, rh);
    const fg = new Uint8Array(rw * rh);
    let lo = 255;
    let hi = 0;
    let count = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const p = at(x, y);
        const r = d[p] ?? 0;
        const g = d[p + 1] ?? 0;
        const b = d[p + 2] ?? 0;
        const lum = (r * 299 + g * 587 + b * 114) / 1000;
        if (lum < lo) lo = lum;
        if (lum > hi) hi = lum;
        const on = bgColour
          ? Math.max(
              Math.abs(r - bgColour[0]),
              Math.abs(g - bgColour[1]),
              Math.abs(b - bgColour[2]),
            ) > tolerance
          : (d[p + 3] ?? 0) >= 128;
        if (on) {
          fg[y * rw + x] = 1;
          count++;
        }
      }
    }
    const region = { x: x0, y: y0, w: rw, h: rh };
    const segmentation = hasAlpha ? 'alpha' : 'colour';
    const flags: CellFlag[] = [];
    if (count < minFill * rw * rh) {
      flags.push(!hasAlpha && hi - lo <= 4 ? 'uniform' : 'empty');
      return { index: cell.index, region, box: null, crop: null, flags, segmentation };
    }
    let bx0 = rw;
    let by0 = rh;
    let bx1 = -1;
    let by1 = -1;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (!fg[y * rw + x]) continue;
        if (x < bx0) bx0 = x;
        if (y < by0) by0 = y;
        if (x > bx1) bx1 = x;
        if (y > by1) by1 = y;
      }
    }
    if (bx0 === 0 || by0 === 0 || bx1 === rw - 1 || by1 === rh - 1) flags.push('touches-edge');
    if (largeComponents(fg, rw, rh, count) > 1) flags.push('fragmented');
    const bw = bx1 - bx0 + 1;
    const bh = by1 - by0 + 1;
    const side = Math.max(bw, bh);
    const ox = Math.floor((side - bw) / 2);
    const oy = Math.floor((side - bh) / 2);
    const out = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const fx = bx0 + x;
        const fy = by0 + y;
        if (!fg[fy * rw + fx]) continue;
        const p = at(fx, fy);
        const q = ((oy + y) * side + ox + x) * 4;
        out[q] = d[p] ?? 0;
        out[q + 1] = d[p + 1] ?? 0;
        out[q + 2] = d[p + 2] ?? 0;
        out[q + 3] = hasAlpha ? (d[p + 3] ?? 0) : 255;
      }
    }
    return {
      index: cell.index,
      region,
      box: { x: x0 + bx0, y: y0 + by0, w: bw, h: bh },
      crop: { width: side, height: side, data: out },
      flags,
      segmentation,
    };
  });
}

/** The median colour of a region's 1-px border (the flat background). */
function borderColour(
  d: Uint8ClampedArray,
  at: (x: number, y: number) => number,
  w: number,
  h: number,
): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const take = (x: number, y: number): void => {
    const p = at(x, y);
    rs.push(d[p] ?? 0);
    gs.push(d[p + 1] ?? 0);
    bs.push(d[p + 2] ?? 0);
  };
  for (let x = 0; x < w; x++) {
    take(x, 0);
    take(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    take(0, y);
    take(w - 1, y);
  }
  const med = (a: number[]): number => a.sort((p, q) => p - q)[a.length >> 1] ?? 0;
  return [med(rs), med(gs), med(bs)];
}

/** 8-connected components that are "large": at least 15% of the largest and 1% of the foreground. */
function largeComponents(fg: Uint8Array, w: number, h: number, total: number): number {
  const label = new Int32Array(w * h);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < fg.length; i++) {
    if (!fg[i] || label[i]) continue;
    const id = sizes.length + 1;
    let size = 0;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const k = stack.pop() ?? 0;
      size++;
      const x = k % w;
      const y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (fg[n] && !label[n]) {
            label[n] = id;
            stack.push(n);
          }
        }
      }
    }
    sizes.push(size);
  }
  const largest = Math.max(...sizes);
  return sizes.filter((s) => s >= 0.15 * largest && s >= 0.01 * total).length;
}
