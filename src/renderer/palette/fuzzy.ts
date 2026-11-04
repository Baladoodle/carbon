/**
 * Fuzzy matching for the command palette (pure).
 *
 * A query is split into words; every word must match, as a subsequence, the
 * label or one of the item's extra terms (its kind, its group). Each word's
 * best alignment is found by dynamic programming and scored:
 *
 * - matching the start of the label or of a word in it scores high
 * - consecutive matched characters score high, gaps cost a little
 * - an exact or prefix match of the whole label wins outright
 *
 * Ties break on shorter labels, then alphabetically, so results are stable.
 */
export interface Match {
  score: number;
  /** Matched character positions in the label (for highlighting). */
  positions: number[];
}

const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 10;
const BONUS_FIRST = 14;
const BONUS_CONSECUTIVE = 8;
const PENALTY_GAP_START = 3;
const PENALTY_GAP = 1;

const isBoundary = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1] ?? '';
  const cur = text[i] ?? '';
  if (/[\s\-_/.:·(]/.test(prev)) return true;
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase(); // camelCase
};

/** The best alignment of one query word in a text, or null. */
export function matchWord(word: string, text: string, wholeBonus = true): Match | null {
  const q = word.toLowerCase();
  const t = text.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (n === 0) return { score: 0, positions: [] };
  if (n > m) return null;
  // Quick subsequence test first.
  let k = 0;
  for (let j = 0; j < m && k < n; j++) if (t[j] === q[k]) k++;
  if (k < n) return null;

  const NEG = -1e9;
  // best[i·m + j]: best score with query[0..i] matched and query[i] at text[j]; from: its predecessor.
  const best = new Float64Array(n * m).fill(NEG);
  const from = new Int32Array(n * m).fill(-1);
  const at = (a: Float64Array, k: number): number => a[k] ?? NEG;
  for (let j = 0; j < m; j++) {
    if (t[j] !== q[0]) continue;
    const bonus = (j === 0 ? BONUS_FIRST : 0) + (isBoundary(text, j) ? BONUS_BOUNDARY : 0);
    best[j] = SCORE_MATCH + bonus - (j > 0 ? Math.min(j, 6) * PENALTY_GAP : 0);
  }
  for (let i = 1; i < n; i++) {
    const row = i * m;
    const prev = (i - 1) * m;
    // A gap from j' to j costs PENALTY_GAP_START + (j - j' - 1) · PENALTY_GAP, so the best
    // gapped predecessor is the running max of prev[j'] + j' · PENALTY_GAP over j' ≤ j - 2.
    let runMax = NEG;
    let runAt = -1;
    for (let j = i; j < m; j++) {
      const jp = j - 2;
      if (jp >= 0 && at(best, prev + jp) > NEG && at(best, prev + jp) + jp * PENALTY_GAP > runMax) {
        runMax = at(best, prev + jp) + jp * PENALTY_GAP;
        runAt = jp;
      }
      if (t[j] !== q[i]) continue;
      const here = SCORE_MATCH + (isBoundary(text, j) ? BONUS_BOUNDARY : 0);
      const before = at(best, prev + j - 1);
      const consecutive = before > NEG ? before + BONUS_CONSECUTIVE : NEG;
      const gapped = runMax > NEG ? runMax - PENALTY_GAP_START - (j - 1) * PENALTY_GAP : NEG;
      if (consecutive > NEG && consecutive >= gapped) {
        best[row + j] = consecutive + here;
        from[row + j] = j - 1;
      } else if (gapped > NEG) {
        best[row + j] = gapped + here;
        from[row + j] = runAt;
      }
    }
  }
  let end = -1;
  let score = NEG;
  const last = (n - 1) * m;
  for (let j = 0; j < m; j++)
    if (at(best, last + j) > score) {
      score = at(best, last + j);
      end = j;
    }
  if (end < 0 || score <= NEG) return null;
  const positions: number[] = [];
  for (let i = n - 1, j = end; i >= 0; i--) {
    positions.push(j);
    j = from[i * m + j] ?? -1;
  }
  positions.reverse();
  if (wholeBonus && t === q) score += 1000;
  else if (wholeBonus && t.startsWith(q)) score += 200;
  return { score, positions };
}

export interface Candidate {
  label: string;
  /** Extra words a query may match (kind, group), scored lower than the label. */
  terms?: readonly string[];
}

/** Scores an item against a whole query; null if any word fails. */
export function matchQuery(query: string, c: Candidate): Match | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, positions: [] };
  let score = 0;
  const positions = new Set<number>();
  // The whole query against the label first: "glass lu" should rank "Glass Lung" top.
  const whole = words.length > 1 ? matchWord(words.join(' '), c.label) : null;
  if (whole) return { score: whole.score + 50, positions: whole.positions };
  for (const w of words) {
    const inLabel = matchWord(w, c.label);
    let bestTerm: Match | null = null;
    for (const t of c.terms ?? []) {
      const m = matchWord(w, t, false);
      if (m && (!bestTerm || m.score > bestTerm.score)) bestTerm = m;
    }
    if (!inLabel && !bestTerm) return null;
    if (inLabel && (!bestTerm || inLabel.score >= bestTerm.score / 2)) {
      score += inLabel.score;
      for (const p of inLabel.positions) positions.add(p);
    } else if (bestTerm) score += bestTerm.score / 2;
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

export interface Ranked<T> {
  item: T;
  match: Match;
}

/** Ranks items for a query: best first, ties by shorter label, then alphabetically. */
export function rank<T extends Candidate>(
  query: string,
  items: readonly T[],
  boost: (item: T) => number = () => 0,
): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const m = matchQuery(query, item);
    if (m) out.push({ item, match: { ...m, score: m.score + boost(item) } });
  }
  return out.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      a.item.label.length - b.item.label.length ||
      a.item.label.localeCompare(b.item.label),
  );
}
