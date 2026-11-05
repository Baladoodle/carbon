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
  const bg: BgColour[] | null = alpha
    ? null
    : typeof mode === 'object'
      ? [{ rgb: [mode[0], mode[1], mode[2]], tol: tolerance }]
      : backgroundModel(d, W, H, layout, sx, sy, rects, tolerance);
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
          Math.max(Math.abs(r - c.rgb[0]), Math.abs(g - c.rgb[1]), Math.abs(b - c.rgb[2])) <= c.tol
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
    // have 1–2 px gaps, so the fill runs against the foreground dilated by `r` (gaps closed), and then
    // regrows `r` steps through background-coloured pixels to give back the true edge.
    const r = Math.max(2, Math.round(4 * Math.min(sx, sy)));
    const barrier = dilate({ w: W, h: H, data: fg }, ellipseKernel(2 * r + 1)).data;
    const reached = new Uint8Array(W * H);
    let queue = new Int32Array(W * H);
    let qt = 0;
    backgroundSites(W, H, layout, sx, sy, rects, (x, y) => {
      const i = y * W + x;
      if (!barrier[i] && !reached[i]) {
        reached[i] = 1;
        queue[qt++] = i;
      }
    });
    const spread = (
      open: (i: number) => boolean,
      from: Int32Array,
      n: number,
      depth: number,
    ): void => {
      let frontier = from.subarray(0, n);
      for (let step = 0; step < depth && frontier.length; step++) {
        const next = new Int32Array(W * H);
        let nt = 0;
        const go = (j: number): void => {
          if (!reached[j] && open(j)) {
            reached[j] = 1;
            next[nt++] = j;
          }
        };
        for (const i of frontier) {
          const x = i % W;
          if (x > 0) go(i - 1);
          if (x < W - 1) go(i + 1);
          if (i >= W) go(i - W);
          if (i + W < W * H) go(i + W);
        }
        frontier = next.subarray(0, nt);
      }
    };
    // flood through the gap-closed background (unbounded), then regrow r steps into the true background
    let qh = 0;
    while (qh < qt) {
      const i = queue[qh++] as number;
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= W * H || reached[j] || barrier[j]) continue;
        reached[j] = 1;
        queue[qt++] = j;
      }
    }
    spread((j) => !fg[j], queue, qt, r);
    queue = new Int32Array(0);
    for (let i = 0; i < W * H; i++) fg[i] = reached[i] ? 0 : 1;
  }

  // which cell a coordinate is in (-1: gutter)
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
/** Where sprites should not be: the sheet border, the planned gutters' centre lines, a ring 2 px inside each cell. */
function backgroundSites(
  W: number,
  H: number,
  layout: SheetLayout,
  sx: number,
  sy: number,
  rects: Array<{ x0: number; y0: number; x1: number; y1: number }>,
  visit: (x: number, y: number) => void,
): void {
  const take = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) visit(x, y);
  };
  for (let x = 0; x < W; x++) for (const y of [0, 1, H - 2, H - 1]) take(x, y);
  for (let y = 0; y < H; y++) for (const x of [0, 1, W - 2, W - 1]) take(x, y);
  const half = layout.gutter / 2;
  for (const c of layout.cells) {
    const gx = Math.round((c.x - half) * sx);
    const gy = Math.round((c.y - half) * sy);
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
): BgColour[] {
  const samples: number[] = [];
  backgroundSites(W, H, layout, sx, sy, rects, (x, y) => {
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
