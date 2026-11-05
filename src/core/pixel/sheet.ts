/**
 * Icon sheets (docs/IMAGES.md §2a): lay N items out on one canvas, draw the
 * guide image, and crop the generated sheet back into one sprite per cell with
 * flags for review. Pure and deterministic.
 */
import { dilate, ellipseKernel } from './cv';
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
   * transparency, else a model of up to 6 background colours sampled where
   * sprites should not be (see `backgroundModel`).
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
  // cell rectangles in sheet pixels
  const rects = layout.cells.map((c) => ({
    x0: Math.floor(c.x * sx),
    y0: Math.floor(c.y * sy),
    x1: Math.min(W, Math.ceil((c.x + c.w) * sx)),
    y1: Math.min(H, Math.ceil((c.y + c.h) * sy)),
  }));
  /**
   * Foreground, parts and their per-cell shares, with the background sampled on the grid shifted
   * by the given per-row / per-column offsets (sheet px): where the model actually drew its gutters.
   */
  const segment = (rowShift: Float64Array, colShift: Float64Array) => {
    const shifted = rects.map((r, i) => {
      const c = layout.cells[i] as SheetCell;
      const ox = Math.round(colShift[c.col] ?? 0);
      const oy = Math.round(rowShift[c.row] ?? 0);
      return {
        x0: Math.max(0, r.x0 + ox),
        y0: Math.max(0, r.y0 + oy),
        x1: Math.min(W, r.x1 + ox),
        y1: Math.min(H, r.y1 + oy),
      };
    });
    const bg: BgColour[] | null = alpha
      ? null
      : typeof mode === 'object'
        ? [{ rgb: [mode[0], mode[1], mode[2]], tol: tolerance }]
        : backgroundModel(d, W, H, layout, sx, sy, shifted, tolerance, rowShift, colShift);
    const fg = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if ((d[o + 3] ?? 0) < 128) continue;
      if (bg) {
        const r = d[o] ?? 0;
        const g = d[o + 1] ?? 0;
        const b = d[o + 2] ?? 0;
        let isBg = false;
        for (const c of bg) {
          if (
            Math.max(Math.abs(r - c.rgb[0]), Math.abs(g - c.rgb[1]), Math.abs(b - c.rgb[2])) <=
            c.tol
          ) {
            isBg = true;
            break;
          }
        }
        if (isBg) continue;
      }
      fg[i] = 1;
    }

    if (bg) {
      // Background is what is background-coloured AND connected to where background must be, so a sprite's
      // interior that matches the backdrop (grey iron on the guide's grey cells) stays sprite. Thin outlines
      // have gaps of a few px, so the fill runs against the foreground dilated by `r` (4 px at 1440², 8 at
      // 2880²; gaps closed), then regrows `r` steps through background-coloured pixels for the true edge.
      const r = Math.max(2, Math.round(8 * Math.min(sx, sy)));
      const barrier = dilate({ w: W, h: H, data: fg }, ellipseKernel(2 * r + 1)).data;
      const reached = new Uint8Array(W * H);
      let queue = new Int32Array(W * H);
      let qt = 0;
      backgroundSites(W, H, layout, sx, sy, shifted, rowShift, colShift, (x, y) => {
        const i = y * W + x;
        if (!barrier[i] && !reached[i]) {
          reached[i] = 1;
          queue[qt++] = i;
        }
      });
      // flood through the gap-closed background (unbounded) ...
      let qh = 0;
      const push = (j: number): void => {
        if (!reached[j] && !barrier[j]) {
          reached[j] = 1;
          queue[qt++] = j;
        }
      };
      while (qh < qt) {
        const i = queue[qh++] as number;
        const x = i % W;
        if (x > 0) push(i - 1);
        if (x < W - 1) push(i + 1);
        if (i >= W) push(i - W);
        if (i + W < W * H) push(i + W);
      }
      // ... then regrow r steps from everything reached into background-coloured pixels: the true edge
      let frontier = queue.subarray(0, qt);
      let next = new Int32Array(Math.min(W * H, qt * 4 + 16));
      for (let step = 0; step < r && frontier.length; step++) {
        let nt = 0;
        const grow = (j: number): void => {
          if (!reached[j] && !fg[j]) {
            reached[j] = 1;
            if (nt >= next.length) {
              const bigger = new Int32Array(next.length * 2);
              bigger.set(next);
              next = bigger;
            }
            next[nt++] = j;
          }
        };
        for (const i of frontier) {
          const x = i % W;
          if (x > 0) grow(i - 1);
          if (x < W - 1) grow(i + 1);
          if (i >= W) grow(i - W);
          if (i + W < W * H) grow(i + W);
        }
        frontier = next.slice(0, nt);
      }
      queue = new Int32Array(0); // release the flood buffer before labelling
      for (let i = 0; i < W * H; i++) fg[i] = reached[i] ? 0 : 1;
    }

    // which cell a coordinate is in (-1: gutter)
    const colOf = new Int32Array(W).fill(-1);
    const rowOf = new Int32Array(H).fill(-1);
    layout.cells.forEach((c, i) => {
      const r = shifted[i] as (typeof rects)[number];
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

    const cellArea =
      (rects[0] ? (rects[0].x1 - rects[0].x0) * (rects[0].y1 - rects[0].y0) : 1) || 1;
    const minPart = Math.max(4, Math.round(cellArea * 0.0005));
    const big = parts.flatMap((p, id) => (p.size >= minPart ? [id] : []));
    return { bg, label, parts, big, minPart };
  };

  // Register the model's grid. It keeps its own even grid, which drifts from ours (28 px on a 2.6
  // sheet, 72 px — more than a gutter — on a 2.5 sheet at 2880²), so each part goes to the cell whose
  // CORRECTED centre is nearest its centroid, and each row's and column's correction is the median
  // offset of its sprites' centres. Assign, re-estimate, repeat until stable.
  const centres = layout.cells.map((c) => ({ x: (c.x + c.w / 2) * sx, y: (c.y + c.h / 2) * sy }));
  const pitchX = ((layout.cells[0]?.w ?? 1) + layout.gutter) * sx;
  const pitchY = ((layout.cells[0]?.h ?? 1) + layout.gutter) * sy;
  const rowOff = new Float64Array(layout.rows);
  const colOff = new Float64Array(layout.cols);
  let owned: number[][] = [];
  let parts: Part[] = [];
  let big: number[] = [];
  const registerGrid = (): void => {
    rowOff.fill(0);
    colOff.fill(0);
    const assign = (): number[][] => {
      const out = layout.cells.map((): number[] => []);
      for (const id of big) {
        const p = parts[id] as Part;
        const cx = p.sumX / p.size;
        const cy = p.sumY / p.size;
        let best = -1;
        let bestD = Infinity;
        layout.cells.forEach((c, i) => {
          const ce = centres[i] as { x: number; y: number };
          const dx = (cx - ce.x - (colOff[c.col] ?? 0)) / pitchX;
          const dy = (cy - ce.y - (rowOff[c.row] ?? 0)) / pitchY;
          const dist = dx * dx + dy * dy;
          if (dist < bestD) {
            bestD = dist;
            best = i;
          }
        });
        // further than a whole pitch from every corrected centre: a stray mark, nobody's sprite
        if (best >= 0 && bestD <= 1) out[best]?.push(id);
      }
      return out;
    };
    const median = (v: number[]): number => {
      const t = [...v].sort((p, q) => p - q);
      return t.length ? (t[t.length >> 1] ?? 0) : 0;
    };
    /** Re-estimate each row's and column's offset from an assignment; the largest change. */
    const register = (o: number[][]): number => {
      const byRow: number[][] = Array.from({ length: layout.rows }, () => []);
      const byCol: number[][] = Array.from({ length: layout.cols }, () => []);
      layout.cells.forEach((c, i) => {
        const ids = o[i] ?? [];
        if (!ids.length) return;
        // the sprite's centre: the size-weighted centroid of its parts
        let n = 0;
        let mx = 0;
        let my = 0;
        for (const id of ids) {
          const p = parts[id] as Part;
          n += p.size;
          mx += p.sumX;
          my += p.sumY;
        }
        const ce = centres[i] as { x: number; y: number };
        byRow[c.row]?.push(my / n - ce.y);
        byCol[c.col]?.push(mx / n - ce.x);
      });
      // a row or column with fewer than 3 sprites has no meaningful median: use the whole sheet's (or none)
      const allY = byRow.flat();
      const allX = byCol.flat();
      const est = (v: number[], all: number[]): number =>
        median(v.length >= 3 ? v : all.length >= 3 ? all : []);
      let moved = 0;
      for (let r = 0; r < layout.rows; r++) {
        const v = est(byRow[r] ?? [], allY);
        moved = Math.max(moved, Math.abs(v - (rowOff[r] ?? 0)));
        rowOff[r] = v;
      }
      for (let k = 0; k < layout.cols; k++) {
        const v = est(byCol[k] ?? [], allX);
        moved = Math.max(moved, Math.abs(v - (colOff[k] ?? 0)));
        colOff[k] = v;
      }
      return moved;
    };
    for (let iter = 0; iter < 4; iter++) {
      owned = assign();
      if (register(owned) < 1) break;
    }
    // Banding: the model draws an even grid, so sprite centres form `rows` horizontal and `cols`
    // vertical bands. When both axes split cleanly, a part's band ranks ARE its row and column, which
    // holds however far a stretched grid drifts (the medians above can lock onto a wrong row once a
    // whole row starts out misassigned).
    const centroidsX = big.map((id) => (parts[id] as Part).sumX / (parts[id] as Part).size);
    const centroidsY = big.map((id) => (parts[id] as Part).sumY / (parts[id] as Part).size);
    const rowCut = bands(centroidsY, layout.rows, pitchY);
    const colCut = bands(centroidsX, layout.cols, pitchX);
    if (rowCut && colCut) {
      const cellAtRC = new Map(layout.cells.map((c) => [c.row * 100000 + c.col, c.index]));
      const banded = layout.cells.map((): number[] => []);
      big.forEach((id, k) => {
        const row = rowCut.filter((t) => (centroidsY[k] ?? 0) > t).length;
        const col = colCut.filter((t) => (centroidsX[k] ?? 0) > t).length;
        const ci = cellAtRC.get(row * 100000 + col);
        if (ci !== undefined) banded[ci]?.push(id);
      });
      owned = banded;
    } else {
      owned = assign();
    }
    register(owned); // the offsets the reach check uses come from the final assignment
  };

  // Segment on the planned grid and register it. An opaque sheet's background is sampled at the
  // gutters and cell rings, so when the model's grid drifted (more than a quarter gutter), sample
  // again where it actually drew them and segment once more: planned gutter lines can run through
  // drifted sprites and, on a backdrop-coloured sprite (grey iron on grey cells), seed the flood
  // inside it.
  let seg = segment(rowOff, colOff);
  ({ parts, big } = seg);
  registerGrid();
  const drift = Math.max(...rowOff.map(Math.abs), ...colOff.map(Math.abs));
  if (seg.bg && drift > (layout.gutter / 4) * Math.min(sx, sy)) {
    seg = segment(Float64Array.from(rowOff), Float64Array.from(colOff));
    ({ parts, big } = seg);
    registerGrid();
  }
  const { label } = seg;
  owned.forEach((ids, i) => {
    for (const id of ids) (parts[id] as Part).owner = i;
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
    // or reaches past where the model actually drew the cell (corrected), plus half a gutter
    const hx = (layout.gutter / 2) * sx;
    const hy = (layout.gutter / 2) * sy;
    const ox0 = r.x0 + (colOff[cell.col] ?? 0) - hx;
    const oy0 = r.y0 + (rowOff[cell.row] ?? 0) - hy;
    const ox1 = r.x1 + (colOff[cell.col] ?? 0) + hx;
    const oy1 = r.y1 + (rowOff[cell.row] ?? 0) + hy;
    const fringe = Math.max(1, Math.round(2 * Math.min(sx, sy))); // a blended edge pixel at 1440², two at 2880²
    const reaches = ids.some((id) => {
      const p = parts[id] as Part;
      return (
        p.x0 < ox0 - fringe ||
        p.y0 < oy0 - fringe ||
        p.x1 + 1 > ox1 + fringe ||
        p.y1 + 1 > oy1 + fringe
      );
    });
    if (bleeds || reaches) flags.push('touches_edge');
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

interface BgColour {
  rgb: [number, number, number];
  /** max channel distance still counted as this background colour */
  tol: number;
}

/**
 * The background of an opaque sheet as up to 6 colours, each with its own
 * tolerance. Samples come from where sprites should not be: the sheet's outer
 * border, the centre lines of the planned gutters, and a ring 2 px inside each
 * cell's edge. That covers a flat backdrop, a textured or grungy one, and a
 * repainted guide (MID-GREY cells on a DARK GREY gutter: two colours). Samples
 * are binned (4 bits per channel), merged greedily within 40 levels, and
 * clusters under 4% of the samples are dropped (sprite pixels that strayed into
 * a ring). A colour's tolerance is the larger of `tolerance` and its own
 * spread (1.5 × the 95th-percentile distance of its samples, plus 8): the
 * percentile ignores sprite pixels that strayed into a ring, the factor reaches
 * a grungy texture's extremes; sprite interiors that share the colour
 * are protected by the connectivity rule in `cropSheet`, not by the tolerance.
 */
/**
 * Split 1-D centres into exactly `k` bands at the k−1 largest gaps; the cut points, or null when the
 * split is not clean (a gap under 0.3 pitch, or a band wider than 0.6 pitch).
 */
function bands(values: number[], k: number, pitch: number): number[] | null {
  if (k <= 1) return [];
  const v = [...values].sort((a, b) => a - b);
  if (v.length < k) return null;
  const gaps = v.slice(1).map((x, i) => ({ i, gap: x - (v[i] ?? 0) }));
  const cuts = [...gaps]
    .sort((a, b) => b.gap - a.gap || a.i - b.i)
    .slice(0, k - 1)
    .sort((a, b) => a.i - b.i);
  if (cuts.some((c) => c.gap < 0.3 * pitch)) return null;
  let start = 0;
  for (const c of [...cuts.map((c) => c.i + 1), v.length]) {
    if ((v[c - 1] ?? 0) - (v[start] ?? 0) > 0.6 * pitch) return null;
    start = c;
  }
  return cuts.map((c) => ((v[c.i] ?? 0) + (v[c.i + 1] ?? 0)) / 2);
}

/** Where sprites should not be: the sheet border, the planned gutters' centre lines, a ring 2 px inside each cell. */
function backgroundSites(
  W: number,
  H: number,
  layout: SheetLayout,
  sx: number,
  sy: number,
  rects: Array<{ x0: number; y0: number; x1: number; y1: number }>,
  rowShift: Float64Array,
  colShift: Float64Array,
  visit: (x: number, y: number) => void,
): void {
  const take = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) visit(x, y);
  };
  for (let x = 0; x < W; x++) for (const y of [0, 1, H - 2, H - 1]) take(x, y);
  for (let y = 0; y < H; y++) for (const x of [0, 1, W - 2, W - 1]) take(x, y);
  const half = layout.gutter / 2;
  for (const c of layout.cells) {
    const gx = Math.round((c.x - half) * sx + (colShift[c.col] ?? 0));
    const gy = Math.round((c.y - half) * sy + (rowShift[c.row] ?? 0));
    for (let y = 0; y < H; y += 2) take(gx, y);
    for (let x = 0; x < W; x += 2) take(x, gy);
  }
  for (const r of rects) {
    for (let x = r.x0 + 2; x < r.x1 - 2; x += 2) {
      take(x, r.y0 + 2);
      take(x, r.y1 - 3);
    }
    for (let y = r.y0 + 2; y < r.y1 - 2; y += 2) {
      take(r.x0 + 2, y);
      take(r.x1 - 3, y);
    }
  }
}

function backgroundModel(
  d: Uint8ClampedArray,
  W: number,
  H: number,
  layout: SheetLayout,
  sx: number,
  sy: number,
  rects: Array<{ x0: number; y0: number; x1: number; y1: number }>,
  tolerance: number,
  rowShift: Float64Array,
  colShift: Float64Array,
): BgColour[] {
  const samples: number[] = [];
  backgroundSites(W, H, layout, sx, sy, rects, rowShift, colShift, (x, y) => {
    const o = (y * W + x) * 4;
    samples.push(((d[o] ?? 0) << 16) | ((d[o + 1] ?? 0) << 8) | (d[o + 2] ?? 0));
  });
  const bins = new Map<number, number>();
  for (const v of samples) {
    const k = ((v >> 20) & 15) * 256 + ((v >> 12) & 15) * 16 + ((v >> 4) & 15);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  const clusters: Array<{ sum: [number, number, number]; n: number }> = [];
  const centre = (k: number): [number, number, number] => [
    ((k >> 8) & 15) * 16 + 8,
    ((k >> 4) & 15) * 16 + 8,
    (k & 15) * 16 + 8,
  ];
  for (const [k, n] of [...bins].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const c = centre(k);
    const hit = clusters.find((cl) => {
      const m = cl.sum.map((v) => v / cl.n);
      return (
        Math.max(
          Math.abs(c[0] - (m[0] ?? 0)),
          Math.abs(c[1] - (m[1] ?? 0)),
          Math.abs(c[2] - (m[2] ?? 0)),
        ) <= 40
      );
    });
    if (hit) {
      hit.sum = [hit.sum[0] + c[0] * n, hit.sum[1] + c[1] * n, hit.sum[2] + c[2] * n];
      hit.n += n;
    } else {
      clusters.push({ sum: [c[0] * n, c[1] * n, c[2] * n], n });
    }
  }
  const kept = clusters
    .filter((cl) => cl.n >= 0.04 * samples.length)
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map((cl) => cl.sum.map((v) => Math.round(v / cl.n)) as [number, number, number]);
  const dist = (v: number, m: [number, number, number]): number =>
    Math.max(
      Math.abs(((v >> 16) & 255) - m[0]),
      Math.abs(((v >> 8) & 255) - m[1]),
      Math.abs((v & 255) - m[2]),
    );
  const members: number[][] = kept.map(() => []);
  for (const v of samples) {
    let best = -1;
    let bestD = Infinity;
    kept.forEach((m, i) => {
      const dd = dist(v, m);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    if (best >= 0 && bestD <= 64) members[best]?.push(bestD);
  }
  return kept.map((rgb, i) => {
    const ds = (members[i] ?? []).sort((a, b) => a - b);
    // p95 ignores the few sprite pixels that stray into the sampling rings; ×1.5 reaches a texture's extremes
    const p95 = ds[Math.floor(ds.length * 0.95)] ?? 0;
    return { rgb, tol: Math.max(tolerance, Math.round(p95 * 1.5) + 8) };
  });
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
