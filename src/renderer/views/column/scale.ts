/**
 * The Column's vertical scale (docs/EXPERIENCE.md §2): a symmetric log around
 * Y 0, endless in both directions. Pure; no DOM.
 *
 *   u(y) = sign(y) · log10(1 + |y| / C)
 *
 * It is linear near 0 (|y| ≪ C) and logarithmic far from it, so the surface
 * gets room while depths and heights of thousands still fit on one screen.
 * One unit of `u` is one decade far from 0.
 */
export const LINEAR = 16;

export function toU(y: number): number {
  if (y === Infinity) return Infinity;
  if (y === -Infinity) return -Infinity;
  return Math.sign(y) * Math.log10(1 + Math.abs(y) / LINEAR);
}

export function fromU(u: number): number {
  if (u === Infinity) return Infinity;
  if (u === -Infinity) return -Infinity;
  return Math.sign(u) * LINEAR * (Math.pow(10, Math.abs(u)) - 1);
}

/** Formats a height in mono-friendly form: 0, 64, −512, 1.2k, 40k, 3M, ±∞. */
export function formatY(y: number): string {
  if (y === Infinity) return '+∞';
  if (y === -Infinity) return '−∞';
  const sign = y < 0 ? '−' : '';
  const a = Math.abs(y);
  const trim = (n: number): string => String(Number(n.toPrecision(3)));
  let s: string;
  if (a < 1000) s = trim(Math.round(a * 10) / 10);
  else if (a < 1e6) s = `${trim(a / 1e3)}k`;
  else if (a < 1e9) s = `${trim(a / 1e6)}M`;
  else s = `${trim(a / 1e9)}G`;
  return s === '0' ? '0' : sign + s;
}

export interface Tick {
  y: number;
  u: number;
  /** A decade boundary (±10^k): the only ticks with a label. */
  major: boolean;
  label?: string;
}

/**
 * Ruler ticks between `uLo` and `uHi` at `pxPerU` pixels per unit: m·10^k on
 * both sides of 0 (m = 1…9), keeping only ticks at least `minGapPx` apart from
 * their neighbour on the same side; labels only at decade boundaries, and only
 * when they're at least `labelGapPx` from the previous label. Y 0 is not a
 * tick here (it gets its own accent mark, with no label).
 */
export function ticks(
  uLo: number,
  uHi: number,
  pxPerU: number,
  minGapPx = 5,
  labelGapPx = 22,
): Tick[] {
  const out: Tick[] = [];
  for (const sign of [1, -1] as const) {
    const limit = sign > 0 ? uHi : -uLo;
    if (limit <= 0) continue;
    let lastU = 0;
    let lastLabelU = 0;
    for (let k = 0; k < 12; k++) {
      for (let m = 1; m <= 9; m++) {
        const y = m * Math.pow(10, k);
        const u = toU(y);
        if (u > limit) break;
        const major = m === 1 && k >= 1;
        if ((u - lastU) * pxPerU < minGapPx && !major) continue;
        lastU = u;
        const tick: Tick = { y: sign * y, u: sign * u, major };
        if (major && (u - lastLabelU) * pxPerU >= labelGapPx) {
          tick.label = formatY(sign * y);
          lastLabelU = u;
        }
        out.push(tick);
      }
      if (toU(Math.pow(10, k + 1)) > limit) break;
    }
  }
  return out.sort((a, b) => b.u - a.u);
}

/**
 * A "nice" height near `y` for dragging edges: rounded to two significant
 * digits on the scale's own resolution (so it snaps to 64, 96, 120, 1.2k …,
 * and to integers near 0).
 */
export function snapY(y: number): number {
  if (!Number.isFinite(y)) return y;
  const a = Math.abs(y);
  if (a < 10) return Math.round(y);
  const step = Math.pow(10, Math.floor(Math.log10(a)) - 1);
  const snapped = Math.round(y / step) * step;
  return Number(snapped.toPrecision(12));
}
