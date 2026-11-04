/**
 * Duplicate and near-duplicate names: normalised edit distance (pure).
 */

/** Lower case, no accents or punctuation, single spaces, no leading article. */
export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/**
 * Levenshtein distance, or `max + 1` as soon as it must exceed `max`. With a
 * finite `max` only the diagonal band of width `2·max + 1` is computed, so
 * comparing a name against thousands stays cheap.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0 || b.length === 0) {
    const d = a.length + b.length;
    return d > max ? max + 1 : d;
  }
  const BIG = 0x3fffffff;
  const n = b.length;
  const w = Number.isFinite(max) ? max : Math.max(a.length, n);
  if (rowA.length <= n + 1) {
    rowA = new Int32Array(2 * (n + 2));
    rowB = new Int32Array(2 * (n + 2));
  }
  let prev = rowA;
  let cur = rowB;
  prev.fill(BIG, 0, n + 2);
  for (let j = 0; j <= Math.min(n, w); j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const lo = Math.max(1, i - w);
    const hi = Math.min(n, i + w);
    // Only the band and the cells just outside it are ever read.
    cur[lo - 1] = lo - 1 === 0 && i <= w ? i : BIG;
    if (hi + 1 <= n) cur[hi + 1] = BIG;
    let rowMin = cur[lo - 1] as number;
    const ca = a.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      const sub = (prev[j - 1] as number) + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = (prev[j] as number) + 1;
      const ins = (cur[j - 1] as number) + 1;
      const v = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  const d = prev[n] as number;
  return d > max ? max + 1 : d;
}

/** Scratch rows for editDistance, reused between calls (it is synchronous). */
let rowA = new Int32Array(64);
let rowB = new Int32Array(64);

/** Normalised distance in 0..1: the edit distance over the longer length. */
export const nameDistance = (a: string, b: string): number => {
  const n = Math.max(a.length, b.length);
  return n === 0 ? 0 : editDistance(a, b) / n;
};

/** Names this close (and at least this long) count as near-duplicates. */
export const NEAR_THRESHOLD = 0.25;
export const NEAR_MIN_LENGTH = 4;

export type NameMatch = 'same' | 'near' | null;

/** A character histogram of a normalised name (a–z, 0–9, space). */
export function nameSignature(n: string): Uint8Array {
  const h = new Uint8Array(37);
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    const k = c >= 97 && c <= 122 ? c - 97 : c >= 48 && c <= 57 ? c - 22 : 36;
    h[k] = Math.min(255, (h[k] ?? 0) + 1);
  }
  return h;
}

/**
 * A lower bound on the edit distance from two histograms: one edit changes at
 * most two counts by one each. Rejects most pairs in 37 steps.
 */
function histogramBound(x: Uint8Array, y: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < 37; i++) d += Math.abs((x[i] ?? 0) - (y[i] ?? 0));
  return Math.ceil(d / 2);
}

/** Compares two normalised names (signatures, when given, make it cheaper). */
export function compareNames(
  a: string,
  b: string,
  sigs?: readonly [Uint8Array, Uint8Array],
): NameMatch {
  if (a === '' || b === '') return null;
  if (a === b) return 'same';
  if (a.length < NEAR_MIN_LENGTH || b.length < NEAR_MIN_LENGTH) return null;
  const longer = Math.max(a.length, b.length);
  const max = Math.floor(longer * NEAR_THRESHOLD);
  if (Math.abs(a.length - b.length) > max) return null;
  if (sigs && histogramBound(sigs[0], sigs[1]) > max) return null;
  return editDistance(a, b, max) <= max ? 'near' : null;
}
