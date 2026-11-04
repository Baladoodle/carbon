/**
 * The spread field's geometry (docs/VISUAL.md §6.3): candidates sit at their
 * model-given positions on two axes, nudged apart so no two cards overlap, and
 * keyboard navigation moves between them. Pure and deterministic.
 */

export interface FieldPoint {
  key: string;
  /** 0..1 on the x axis (low → high, left → right). */
  x: number;
  /** 0..1 on the y axis (low → high, bottom → top). */
  y: number;
}

export interface FieldBox {
  /** Field size in px. */
  width: number;
  height: number;
  /** Card size in px. */
  cardW: number;
  cardH: number;
  /** Gap kept between cards and around the edge. */
  gap: number;
}

export interface Placed {
  key: string;
  /** Top-left corner in px. */
  left: number;
  top: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Places cards: each wants to sit centred on its axis position. Cards are
 * placed one at a time in key order (so arrival order doesn't matter); a card
 * whose spot is taken goes to the nearest free spot on a half-card grid around
 * it. When the field is too full for that, it keeps its own spot and overlaps.
 */
export function layoutField(points: readonly FieldPoint[], box: FieldBox): Placed[] {
  const { width, height, cardW, cardH, gap } = box;
  const minL = gap;
  const minT = gap;
  const maxL = Math.max(minL, width - cardW - gap);
  const maxT = Math.max(minT, height - cardH - gap);
  const sorted = [...points].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const w = cardW + gap;
  const h = cardH + gap;
  const stepX = w / 2;
  const stepY = h / 2;
  const maxR = Math.ceil(Math.max(width / stepX, height / stepY)) + 1;
  const placed: Placed[] = [];
  const free = (l: number, t: number): boolean =>
    placed.every((p) => Math.abs(p.left - l) >= w || Math.abs(p.top - t) >= h);
  // Ring offsets, nearest first; computed once.
  const rings: [number, number][][] = [];
  for (let r = 1; r <= maxR; r++) {
    const ring: [number, number][] = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
    ring.sort(
      (a, b) =>
        Math.hypot(a[0] * stepX, a[1] * stepY) - Math.hypot(b[0] * stepX, b[1] * stepY) ||
        a[1] - b[1] ||
        a[0] - b[0],
    );
    rings.push(ring);
  }
  for (const p of sorted) {
    const left = Math.round(minL + clamp(p.x, 0, 1) * (maxL - minL));
    // y grows upward on the field, downward on screen.
    const top = Math.round(minT + (1 - clamp(p.y, 0, 1)) * (maxT - minT));
    let spot: Placed | undefined = free(left, top) ? { key: p.key, left, top } : undefined;
    for (const ring of rings) {
      if (spot) break;
      for (const [dx, dy] of ring) {
        const l = Math.round(left + dx * stepX);
        const t = Math.round(top + dy * stepY);
        if (l < minL || l > maxL || t < minT || t > maxT) continue;
        if (free(l, t)) {
          spot = { key: p.key, left: l, top: t };
          break;
        }
      }
    }
    placed.push(spot ?? { key: p.key, left, top });
  }
  return placed;
}

/** Whether two placed cards overlap. */
export const overlaps = (a: Placed, b: Placed, cardW: number, cardH: number): boolean =>
  Math.abs(a.left - b.left) < cardW && Math.abs(a.top - b.top) < cardH;

/** Reading order on screen: top to bottom, then left to right. */
export function readingOrder(placed: readonly Placed[]): string[] {
  return [...placed]
    .sort((a, b) => a.top - b.top || a.left - b.left || (a.key < b.key ? -1 : 1))
    .map((p) => p.key);
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * The nearest card in a direction from `from` (screen coordinates), preferring
 * cards close to the line of travel. `undefined` if there's none that way.
 */
export function neighbour(
  placed: readonly Placed[],
  from: string,
  dir: Direction,
): string | undefined {
  const a = placed.find((p) => p.key === from);
  if (!a) return undefined;
  let best: { key: string; cost: number } | undefined;
  for (const b of placed) {
    if (b.key === from) continue;
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const cost = along + 2 * across;
    if (!best || cost < best.cost || (cost === best.cost && b.key < best.key))
      best = { key: b.key, cost };
  }
  return best?.key;
}
