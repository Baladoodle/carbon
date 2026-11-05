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

/**
 * The guide follows Genforge's tile drafts (genforge/walls/draft.py, prompts.py):
 * flat colours on an invisible grid, no drawn lines, every colour named in the
 * prompt's words. Cells are MID-GREY (Genforge's GROUND, 140) squares on a DARK
 * GREY (its FACE, 78) gutter; `sheetPrompt` names them the same way.
 */
export const GUIDE_CELL: readonly [number, number, number] = [140, 140, 140];
export const GUIDE_GUTTER: readonly [number, number, number] = [78, 78, 78];
export const GUIDE_NAMES = { cell: 'MID-GREY', gutter: 'DARK GREY' } as const;

export interface GuideOptions {
  cell?: readonly [number, number, number];
  gutter?: readonly [number, number, number];
}

/** The guide image at `canvas` size (the layout's by default): flat cells on a flat gutter. */
export function drawGuide(
  layout: SheetLayout,
  canvas: { w: number; h: number } = layout.canvas,
  opts: GuideOptions = {},
): RgbaImage {
  const [gr, gg, gb] = opts.gutter ?? GUIDE_GUTTER;
  const [cr, cg, cb] = opts.cell ?? GUIDE_CELL;
  const { w: W, h: H } = canvas;
  const sx = W / layout.canvas.w;
  const sy = H / layout.canvas.h;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < data.length; p += 4) data.set([gr, gg, gb, 255], p);
  for (const cell of layout.cells) {
    const x0 = Math.round(cell.x * sx);
    const y0 = Math.round(cell.y * sy);
    const x1 = Math.min(W, Math.round((cell.x + cell.w) * sx));
    const y1 = Math.min(H, Math.round((cell.y + cell.h) * sy));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) data.set([cr, cg, cb, 255], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
}

export type CellFlag = 'empty' | 'background_only' | 'touches_edge' | 'fragmented';

export interface CropOptions {
  /**
   * How to tell background from sprite: `'alpha'` (transparent sheet), a flat
   * `[r, g, b]` colour, or `'auto'` (default): alpha when the sheet has any
   * transparency, else the median colour of the sheet's outer border.
   */
  background?: 'auto' | 'alpha' | readonly [number, number, number];
  /** Pixels reported around each cell in `region`, into the gutter. Default: half the gutter. */
  margin?: number;
  /** Max channel distance from the background colour that still counts as background. Default 32. */
  tolerance?: number;
  /** Foreground below this fraction of the cell area is "empty". Default 0.005. */
  minFill?: number;
}

export interface CroppedCell {
  index: number;
  /** The cell (plus margin) in sheet coordinates: where the sprite was expected. */
  region: { x: number; y: number; w: number; h: number };
  /** The sprite's bounding box, in sheet coordinates, or null when nothing was found. */
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** The sprite padded to a square; everything not its own is transparent. Null when empty. */
  crop: RgbaImage | null;
  flags: CellFlag[];
  /** How the background was found. */
  segmentation: 'alpha' | 'colour';
}

interface Part {
  size: number;
  sumX: number;
  sumY: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sheetEdge: boolean;
  /** pixels inside each cell rectangle, by cell index */
  inCell: Map<number, number>;
  owner: number;
}

/**
 * Cut a generated sheet into one sprite per cell.
 *
 * The model keeps its own even grid, which drifts from the planned one (by up to
 * ~28 px of a 58 px gutter on a real 2880² sheet), so cells are not cut by their
 * bounds. Instead the whole sheet is segmented once into 8-connected foreground
 * parts, and **each part belongs to the cell its centre falls in** (the nearest
 * cell when the centre lies in a gutter). A sprite that drifts across a cell
 * line therefore stays whole and unflagged.
 *
 * Flags: `empty` (too little foreground; `background_only` instead when the cell
 * is one flat colour, or when "foreground" fills it, i.e. the background was
 * painted as a sprite); `touches_edge` when the sprite truly runs into a
 * neighbour's sprite (one connected part with a real share of its pixels in
 * another occupied cell) or into the sheet edge; `fragmented` when the cell owns
 * more than one large part. Specks smaller than 0.05% of a cell are ignored.
 */
export function cropSheet(
  sheet: RgbaImage,
  layout: SheetLayout,
  opts: CropOptions = {},
): CroppedCell[] {
  const { width: W, height: H, data: d } = sheet;
  if (d.length !== W * H * 4)
    throw new PixelError(`sheet data has ${d.length} bytes, expected ${W * H * 4}`);
  const sx = W / layout.canvas.w;
  const sy = H / layout.canvas.h;
  const margin = opts.margin ?? Math.floor(layout.gutter / 2);
  const tolerance = opts.tolerance ?? 32;
  const minFill = opts.minFill ?? 0.005;
  const mode = opts.background ?? 'auto';

  let alpha = mode === 'alpha';
  if (mode === 'auto') {
    for (let p = 3; p < d.length; p += 4) {
      if ((d[p] ?? 255) < 255) {
        alpha = true;
        break;
      }
    }
  }
  const bg = alpha ? null : typeof mode === 'object' ? mode : sheetBorderColour(d, W, H);
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if ((d[o + 3] ?? 0) < 128) continue;
    if (bg) {
      const dist = Math.max(
        Math.abs((d[o] ?? 0) - bg[0]),
        Math.abs((d[o + 1] ?? 0) - bg[1]),
        Math.abs((d[o + 2] ?? 0) - bg[2]),
      );
      if (dist <= tolerance) continue;
    }
    fg[i] = 1;
  }

  // cell rectangles in sheet pixels, and a per-axis lookup of which cell a coordinate is in (-1: gutter)
  const rects = layout.cells.map((c) => ({
    x0: Math.floor(c.x * sx),
    y0: Math.floor(c.y * sy),
    x1: Math.min(W, Math.ceil((c.x + c.w) * sx)),
    y1: Math.min(H, Math.ceil((c.y + c.h) * sy)),
  }));
  const colOf = new Int32Array(W).fill(-1);
  const rowOf = new Int32Array(H).fill(-1);
  layout.cells.forEach((c, i) => {
    const r = rects[i] as (typeof rects)[number];
    for (let x = r.x0; x < r.x1; x++) colOf[x] = c.col;
    for (let y = r.y0; y < r.y1; y++) rowOf[y] = c.row;
  });
  const cellAt = new Map<number, number>(
    layout.cells.map((c) => [c.row * 100000 + c.col, c.index]),
  );

  // 8-connected parts over the whole sheet
  const label = new Int32Array(W * H).fill(-1);
  const parts: Part[] = [];
  const stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!fg[s] || label[s] !== -1) continue;
    const id = parts.length;
    const part: Part = {
      size: 0,
      sumX: 0,
      sumY: 0,
      x0: W,
      y0: H,
      x1: -1,
      y1: -1,
      sheetEdge: false,
      inCell: new Map(),
      owner: -1,
    };
    parts.push(part);
    let top = 0;
    stack[top++] = s;
    label[s] = id;
    while (top) {
      const k = stack[--top] as number;
      const x = k % W;
      const y = (k - x) / W;
      part.size++;
      part.sumX += x;
      part.sumY += y;
      if (x < part.x0) part.x0 = x;
      if (y < part.y0) part.y0 = y;
      if (x > part.x1) part.x1 = x;
      if (y > part.y1) part.y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) part.sheetEdge = true;
      const col = colOf[x] as number;
      const row = rowOf[y] as number;
      if (col >= 0 && row >= 0) {
        const ci = cellAt.get(row * 100000 + col);
        if (ci !== undefined) part.inCell.set(ci, (part.inCell.get(ci) ?? 0) + 1);
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const n = ny * W + nx;
          if (fg[n] && label[n] === -1) {
            label[n] = id;
            stack[top++] = n;
          }
        }
      }
    }
  }

  const cellArea = (rects[0] ? (rects[0].x1 - rects[0].x0) * (rects[0].y1 - rects[0].y0) : 1) || 1;
  const minPart = Math.max(4, Math.round(cellArea * 0.0005));
  const owned = layout.cells.map((): number[] => []);
  parts.forEach((p, id) => {
    if (p.size < minPart) return;
    const cx = p.sumX / p.size;
    const cy = p.sumY / p.size;
    let best = -1;
    let bestD = Infinity;
    rects.forEach((r, i) => {
      const dx = cx < r.x0 ? r.x0 - cx : cx >= r.x1 ? cx - r.x1 + 1 : 0;
      const dy = cy < r.y0 ? r.y0 - cy : cy >= r.y1 ? cy - r.y1 + 1 : 0;
      const dist = dx * dx + dy * dy;
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    if (best < 0) return;
    p.owner = best;
    owned[best]?.push(id);
  });
  const occupied = new Set(owned.flatMap((ids, i) => (ids.length ? [i] : [])));

  return layout.cells.map((cell, ci): CroppedCell => {
    const r = rects[ci] as (typeof rects)[number];
    const mx = Math.round(margin * sx);
    const my = Math.round(margin * sy);
    const region = {
      x: Math.max(0, r.x0 - mx),
      y: Math.max(0, r.y0 - my),
      w: Math.min(W, r.x1 + mx) - Math.max(0, r.x0 - mx),
      h: Math.min(H, r.y1 + my) - Math.max(0, r.y0 - my),
    };
    const segmentation = alpha ? 'alpha' : 'colour';
    const ids = owned[ci] ?? [];
    const total = ids.reduce((n, id) => n + (parts[id]?.size ?? 0), 0);
    const area = (r.x1 - r.x0) * (r.y1 - r.y0);
    // a part owned elsewhere with a real share of its pixels here swallowed this cell's sprite
    const absorbed = parts.some(
      (p) => p.owner >= 0 && p.owner !== ci && (p.inCell.get(ci) ?? 0) >= 0.15 * p.size,
    );
    if (total < minFill * area) {
      const flags: CellFlag[] = [isFlat(d, W, r) && !alpha ? 'background_only' : 'empty'];
      if (absorbed) flags.push('touches_edge');
      return { index: cell.index, region, bbox: null, crop: null, flags, segmentation };
    }
    const flags: CellFlag[] = [];
    if (total > 0.97 * area) flags.push('background_only');
    // Truly runs into a neighbour: touches the sheet edge, or is one connected part with a real share
    // of its pixels in another cell that has no sprite of its own (the two sprites merged). Drifting
    // across a cell line next to a neighbour's own separate sprite is not a flag.
    const bleeds = ids.some((id) => {
      const p = parts[id] as Part;
      if (p.sheetEdge) return true;
      for (const [other, n] of p.inCell)
        if (other !== ci && !occupied.has(other) && n >= 0.15 * p.size) return true;
      return false;
    });
    if (bleeds) flags.push('touches_edge');
    const largest = Math.max(...ids.map((id) => parts[id]?.size ?? 0));
    if (
      ids.filter((id) => (parts[id]?.size ?? 0) >= Math.max(0.15 * largest, 0.01 * total)).length >
      1
    )
      flags.push('fragmented');

    let bx0 = W;
    let by0 = H;
    let bx1 = -1;
    let by1 = -1;
    for (const id of ids) {
      const p = parts[id] as Part;
      bx0 = Math.min(bx0, p.x0);
      by0 = Math.min(by0, p.y0);
      bx1 = Math.max(bx1, p.x1);
      by1 = Math.max(by1, p.y1);
    }
    const bw = bx1 - bx0 + 1;
    const bh = by1 - by0 + 1;
    const side = Math.max(bw, bh);
    const ox = Math.floor((side - bw) / 2);
    const oy = Math.floor((side - bh) / 2);
    const mine = new Set(ids);
    const out = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = (by0 + y) * W + bx0 + x;
        if (!mine.has(label[i] as number)) continue;
        const q = ((oy + y) * side + ox + x) * 4;
        out[q] = d[i * 4] ?? 0;
        out[q + 1] = d[i * 4 + 1] ?? 0;
        out[q + 2] = d[i * 4 + 2] ?? 0;
        out[q + 3] = alpha ? (d[i * 4 + 3] ?? 0) : 255;
      }
    }
    return {
      index: cell.index,
      region,
      bbox: { x: bx0, y: by0, w: bw, h: bh },
      crop: { width: side, height: side, data: out },
      flags,
      segmentation,
    };
  });
}

/** The median colour of the sheet's 1-px outer border (the flat background). */
function sheetBorderColour(d: Uint8ClampedArray, W: number, H: number): [number, number, number] {
  const ch: number[][] = [[], [], []];
  const take = (x: number, y: number): void => {
    for (let c = 0; c < 3; c++) ch[c]?.push(d[(y * W + x) * 4 + c] ?? 0);
  };
  for (let x = 0; x < W; x++) {
    take(x, 0);
    take(x, H - 1);
  }
  for (let y = 1; y < H - 1; y++) {
    take(0, y);
    take(W - 1, y);
  }
  const med = (a: number[]): number => a.sort((p, q) => p - q)[a.length >> 1] ?? 0;
  return [med(ch[0] ?? []), med(ch[1] ?? []), med(ch[2] ?? [])];
}

/** A cell that is one flat colour (luminance range ≤ 4): the background, not a missing sprite. */
function isFlat(
  d: Uint8ClampedArray,
  W: number,
  r: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  let lo = 255;
  let hi = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const o = (y * W + x) * 4;
      const lum = ((d[o] ?? 0) * 299 + (d[o + 1] ?? 0) * 587 + (d[o + 2] ?? 0) * 114) / 1000;
      if (lum < lo) lo = lum;
      if (lum > hi) hi = lum;
      if (hi - lo > 4) return false;
    }
  }
  return true;
}
