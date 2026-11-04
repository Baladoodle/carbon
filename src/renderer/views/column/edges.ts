import { cmd, type Command } from '@core/commands/registry';
import type { BandSpan } from './layout';
import { fromU, snapY, toU } from './scale';

/**
 * Band edges (docs/EXPERIENCE.md §2: bands are created and resized by
 * dragging their edges), pure. An edge is a finite height where one band ends
 * and possibly another begins; moving a shared edge moves both bands.
 */
export interface Edge {
  y: number;
  /** The band whose bottom is this edge (it lies above the edge). */
  above: string | null;
  /** The band whose top is this edge (it lies below the edge). */
  below: string | null;
}

export const edgeKey = (e: Edge): string => `${e.above ?? ''}^${e.below ?? ''}`;

/** Every finite band edge; edges at the same height that touch two bands are shared. */
export function edgesOf(bands: readonly BandSpan[]): Edge[] {
  const byY = new Map<number, Edge[]>();
  const add = (y: number, part: Partial<Edge>): void => {
    const list = byY.get(y) ?? [];
    const free = list.find(
      (e) => (part.above && e.above === null) || (part.below && e.below === null),
    );
    if (free) Object.assign(free, part);
    else list.push({ y, above: null, below: null, ...part });
    byY.set(y, list);
  };
  for (const b of bands) {
    if (Number.isFinite(b.top)) add(b.top, { below: b.id });
    if (Number.isFinite(b.bottom)) add(b.bottom, { above: b.id });
  }
  return [...byY.values()].flat().sort((a, b) => b.y - a.y);
}

/** The smallest band height the editor allows, in scale units. */
const MIN_SPAN_U = 0.02;

/**
 * The open interval an edge may move in: it can't pass the far edge of its own
 * bands, and on a side with no band it can't run into the next band.
 */
export function edgeLimits(bands: readonly BandSpan[], edge: Edge): { lo: number; hi: number } {
  const byId = new Map(bands.map((b) => [b.id, b]));
  const others = bands.filter((b) => b.id !== edge.above && b.id !== edge.below);
  const below = edge.below ? byId.get(edge.below) : undefined;
  const above = edge.above ? byId.get(edge.above) : undefined;
  const lo = below
    ? below.bottom
    : Math.max(-Infinity, ...others.map((b) => b.top).filter((t) => t <= edge.y));
  const hi = above
    ? above.top
    : Math.min(Infinity, ...others.map((b) => b.bottom).filter((t) => t >= edge.y));
  return { lo, hi };
}

/** Clamps a wanted height into the limits (keeping a minimum band height), then snaps it. */
export function clampEdge(limits: { lo: number; hi: number }, y: number): number {
  const uLo = toU(limits.lo) + MIN_SPAN_U;
  const uHi = toU(limits.hi) - MIN_SPAN_U;
  if (uLo >= uHi) return fromU((toU(limits.lo) + toU(limits.hi)) / 2);
  const u = Math.max(uLo, Math.min(uHi, toU(y)));
  const raw = fromU(u);
  const snapped = snapY(raw);
  if (snapped > limits.lo && snapped < limits.hi && toU(snapped) >= uLo && toU(snapped) <= uHi)
    return snapped;
  const rounded = Math.round(raw);
  return rounded > limits.lo && rounded < limits.hi ? rounded : raw;
}

/** The commands that move an edge to `y` (one undo step when sent together). */
export function moveEdgeCommands(edge: Edge, y: number): Command[] {
  const out: Command[] = [];
  if (edge.below) out.push(cmd('entity.setField', { id: edge.below, field: 'y_top', value: y }));
  if (edge.above) out.push(cmd('entity.setField', { id: edge.above, field: 'y_bottom', value: y }));
  return out;
}

/** A height one keyboard step from `y` (about 10% in scale terms), snapped and always different. */
export function nudge(y: number, dir: 1 | -1): number {
  for (let k = 1; k < 50; k++) {
    const next = snapY(fromU(toU(y) + dir * 0.04 * k));
    if (next !== y && Math.sign(next - y) === dir) return next;
  }
  return y + dir;
}

/** The finite span a new band takes in an unwritten gap. */
export function newBandSpan(gap: { top: number; bottom: number }): { bottom: number; top: number } {
  const fin = (y: number): boolean => Number.isFinite(y);
  if (fin(gap.top) && fin(gap.bottom)) return { bottom: gap.bottom, top: gap.top };
  if (fin(gap.bottom)) return { bottom: gap.bottom, top: snapY(fromU(toU(gap.bottom) + 0.5)) };
  if (fin(gap.top)) return { bottom: snapY(fromU(toU(gap.top) - 0.5)), top: gap.top };
  return { bottom: -64, top: 64 };
}

/**
 * The span a band drawn by dragging from `a` to `b` takes, kept inside the gap
 * it started in. Too short a drag means "the whole gap" (as with `n`).
 */
export function drawnBandSpan(
  gap: { top: number; bottom: number },
  a: number,
  b: number,
): { bottom: number; top: number } {
  const limits = { lo: gap.bottom, hi: gap.top };
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (Math.abs(toU(hi) - toU(lo)) < 0.05) return newBandSpan(gap);
  const inside = (y: number): number =>
    y <= limits.lo ? limits.lo : y >= limits.hi ? limits.hi : snapY(y);
  const bottom = inside(lo);
  const top = inside(hi);
  if (!(top > bottom) || !Number.isFinite(top) || !Number.isFinite(bottom)) return newBandSpan(gap);
  return { bottom, top };
}

/** The command that creates a band over a span. */
export function createBandCommand(
  span: { bottom: number; top: number },
  name = 'New band',
): Command {
  return cmd('entity.create', {
    kind: 'band',
    name,
    fields: { y_bottom: span.bottom, y_top: span.top },
  });
}
