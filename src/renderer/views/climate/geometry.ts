import type { Climate } from '@core/model/fields';

/**
 * Geometry of the Climate plane: temperature (x, cold → warm) × moisture
 * (y, dry → wet), both 0..1. Biomes are axis-aligned rectangles on it. Pure,
 * so overlaps, empty climate and dragging are tested without a DOM.
 */

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Smallest extent a biome can be resized to, on either axis. */
export const MIN_SIZE = 0.05;
/** Values are stored to two decimals, so files stay tidy and drags are repeatable. */
export const STEP = 0.01;

export const rectOf = (c: Climate): Rect => ({
  x0: c.temperature.min,
  x1: c.temperature.max,
  y0: c.moisture.min,
  y1: c.moisture.max,
});

export const climateOf = (r: Rect): Climate => ({
  temperature: { min: r.x0, max: r.x1 },
  moisture: { min: r.y0, max: r.y1 },
});

export const area = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

/** The intersection of two rectangles, or null if they only touch or don't meet. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const r = {
    x0: Math.max(a.x0, b.x0),
    x1: Math.min(a.x1, b.x1),
    y0: Math.max(a.y0, b.y0),
    y1: Math.min(a.y1, b.y1),
  };
  return r.x1 - r.x0 > 1e-9 && r.y1 - r.y0 > 1e-9 ? r : null;
}

export interface Overlap {
  a: string;
  b: string;
  rect: Rect;
}

/** Every pair of regions that overlap, with the shared area. Ordered by (a, b) id. */
export function overlaps(regions: readonly { id: string; rect: Rect }[]): Overlap[] {
  const sorted = [...regions].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const out: Overlap[] = [];
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const p = sorted[i];
      const q = sorted[j];
      if (!p || !q) continue;
      const rect = intersect(p.rect, q.rect);
      if (rect) out.push({ a: p.id, b: q.id, rect });
    }
  return out;
}

const uniq = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

/**
 * The climate no region covers, as disjoint rectangles inside the unit square.
 * Computed on the grid the region edges make; cells merge along x, then
 * identical runs merge along y, so the list stays short.
 */
export function emptyRegions(rects: readonly Rect[]): Rect[] {
  const clip = (v: number): number => Math.min(1, Math.max(0, v));
  const xs = uniq([0, 1, ...rects.flatMap((r) => [clip(r.x0), clip(r.x1)])]);
  const ys = uniq([0, 1, ...rects.flatMap((r) => [clip(r.y0), clip(r.y1)])]);
  const covered = (cx: number, cy: number): boolean =>
    rects.some((r) => r.x0 <= cx && cx <= r.x1 && r.y0 <= cy && cy <= r.y1);
  // Runs of free cells per row band.
  const rows: { y0: number; y1: number; runs: [number, number][] }[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    const y0 = ys[j] ?? 0;
    const y1 = ys[j + 1] ?? 0;
    const runs: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i++) {
      const x0 = xs[i] ?? 0;
      const x1 = xs[i + 1] ?? 0;
      if (covered((x0 + x1) / 2, (y0 + y1) / 2)) continue;
      const last = runs[runs.length - 1];
      if (last && last[1] === x0) last[1] = x1;
      else runs.push([x0, x1]);
    }
    rows.push({ y0, y1, runs });
  }
  // Merge identical runs in consecutive rows.
  const out: Rect[] = [];
  let open: Rect[] = [];
  for (const row of rows) {
    const next: Rect[] = [];
    for (const [x0, x1] of row.runs) {
      const cont = open.find((r) => r.x0 === x0 && r.x1 === x1 && r.y1 === row.y0);
      if (cont) {
        cont.y1 = row.y1;
        next.push(cont);
      } else next.push({ x0, x1, y0: row.y0, y1: row.y1 });
    }
    for (const r of open) if (!next.includes(r)) out.push(r);
    open = next;
  }
  out.push(...open);
  return out.filter((r) => area(r) > 1e-9).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** The share of the plane no region covers (0..1). */
export const emptyShare = (rects: readonly Rect[]): number =>
  emptyRegions(rects).reduce((s, r) => s + area(r), 0);

const snap = (v: number): number => Math.round(v / STEP) * STEP;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const fix = (r: Rect): Rect => ({
  x0: round2(r.x0),
  x1: round2(r.x1),
  y0: round2(r.y0),
  y1: round2(r.y1),
});

/** A spot for a new biome: the middle of the largest empty area, at most `size` across. */
export function newRegion(rects: readonly Rect[], size = 0.2): Rect {
  const free = emptyRegions(rects).sort((a, b) => area(b) - area(a))[0];
  const host = free ?? { x0: 0, x1: 1, y0: 0, y1: 1 };
  const w = Math.max(Math.min(size, host.x1 - host.x0), Math.min(MIN_SIZE, 1));
  const h = Math.max(Math.min(size, host.y1 - host.y0), Math.min(MIN_SIZE, 1));
  const cx = (host.x0 + host.x1) / 2;
  const cy = (host.y0 + host.y1) / 2;
  const x0 = Math.min(Math.max(0, snap(cx - w / 2)), 1 - w);
  const y0 = Math.min(Math.max(0, snap(cy - h / 2)), 1 - h);
  return fix({ x0, x1: x0 + w, y0, y1: y0 + h });
}

/** Moves a rectangle by (dx, dy), keeping its size and staying inside the plane. */
export function moveRect(r: Rect, dx: number, dy: number): Rect {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const x0 = Math.min(Math.max(0, snap(r.x0 + dx)), round2(1 - w));
  const y0 = Math.min(Math.max(0, snap(r.y0 + dy)), round2(1 - h));
  return fix({ x0, x1: x0 + w, y0, y1: y0 + h });
}

/** Which edges a resize handle drags: `n`, `s`, `e`, `w` and the corners. */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * Resizes by dragging `handle` by (dx, dy). `n` is the wet edge (y1), `e` the
 * warm edge (x1). Edges stay inside the plane and at least MIN_SIZE apart.
 */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number): Rect {
  let { x0, x1, y0, y1 } = r;
  if (handle.includes('e')) x1 = Math.min(1, Math.max(x0 + MIN_SIZE, snap(x1 + dx)));
  if (handle.includes('w')) x0 = Math.max(0, Math.min(x1 - MIN_SIZE, snap(x0 + dx)));
  if (handle.includes('n')) y1 = Math.min(1, Math.max(y0 + MIN_SIZE, snap(y1 + dy)));
  if (handle.includes('s')) y0 = Math.max(0, Math.min(y1 - MIN_SIZE, snap(y0 + dy)));
  return fix({ x0, x1, y0, y1 });
}

export const sameRect = (a: Rect, b: Rect): boolean =>
  a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
