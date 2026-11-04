/**
 * Near-duplicate detection for spread candidates (docs/VISUAL.md §6.3: "near-
 * duplicates are joined by hairlines"). Pure and deterministic: the same texts
 * always give the same score, the score is symmetric, and the pair list doesn't
 * depend on the order candidates arrived in.
 *
 * The score mixes two signals:
 *  - the names, as sets of character trigrams (catches "Glass Lung" / "Glasslung")
 *  - the identities and descriptions, as sets of stemmed content words
 *    (catches the same idea under different names)
 */

export interface Comparable {
  key: string;
  name: string;
  identity: string;
  description?: string | undefined;
}

/** Words that carry no idea of their own. */
const STOP = new Set(
  (
    'a an the and or but of to in on at by for with from into onto over under up down out off ' +
    'it its it’s is are was were be been being this that these those there here then than so as ' +
    'you your yours we our they their them he she his her i me my not no nor only just very ' +
    'can could will would should may might must do does did done has have had having ' +
    'when where while who whom which what why how all any each every some more most less ' +
    'one two three too also even ever still yet again once'
  ).split(' '),
);

/** Lowercases, strips accents and punctuation, and splits into words. */
export function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** A crude, deterministic stemmer: enough to match "glows" with "glowing". */
export function stem(word: string): string {
  let w = word;
  for (const suffix of ['ingly', 'ings', 'ing', 'edly', 'ed', 'ies', 'es', 'ly', 's']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length) + (suffix === 'ies' ? 'y' : '');
      break;
    }
  }
  return w;
}

/** Stemmed content words of a text, as a set. */
export function contentWords(text: string): Set<string> {
  return new Set(
    words(text)
      .filter((w) => !STOP.has(w))
      .map(stem),
  );
}

/** Character trigrams of a name, ignoring spaces and case ("Glass Lung" = "glasslung"). */
export function trigrams(text: string): Set<string> {
  const s = `  ${words(text).join('')} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** |A ∩ B| / |A ∪ B|, with two empty sets counting as 0 (nothing to compare). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const NAME_WEIGHT = 0.45;

/** Similarity of two candidates in [0, 1]. Symmetric and deterministic. */
export function similarity(a: Comparable, b: Comparable): number {
  const name = jaccard(trigrams(a.name), trigrams(b.name));
  const idea = jaccard(
    contentWords(`${a.identity} ${a.description ?? ''}`),
    contentWords(`${b.identity} ${b.description ?? ''}`),
  );
  // Rounded so that floating-point noise can never flip a threshold between runs.
  return Math.round((NAME_WEIGHT * name + (1 - NAME_WEIGHT) * idea) * 1e6) / 1e6;
}

/** Above this, two candidates are near-duplicates and get a hairline. */
export const NEAR_DUPLICATE = 0.42;

export interface SimilarPair {
  a: string;
  b: string;
  score: number;
}

/**
 * Pairs of candidates at or above `threshold`, each pair once with `a < b`
 * (by key), sorted by key. Independent of input order.
 */
export function nearDuplicates(
  items: readonly Comparable[],
  threshold = NEAR_DUPLICATE,
): SimilarPair[] {
  const sorted = [...items].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const out: SimilarPair[] = [];
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const x = sorted[i] as Comparable;
      const y = sorted[j] as Comparable;
      if (x.key === y.key) continue;
      const score = similarity(x, y);
      if (score >= threshold) out.push({ a: x.key, b: y.key, score });
    }
  return out;
}

/**
 * The leading verb-ish word of an identity ("Hums when danger is near" → "hum"),
 * skipping a leading subject ("It", "You", a determiner). The diversity
 * contract says no two candidates share one.
 */
export function leadVerb(identity: string): string | undefined {
  const SUBJECT = new Set(['it', 'you', 'a', 'an', 'the', 'this', 'they', 'its', 'your']);
  for (const w of words(identity)) {
    if (SUBJECT.has(w)) continue;
    return stem(w);
  }
  return undefined;
}

export interface Diversity {
  /** Mean pairwise similarity (0 when fewer than two). */
  meanSimilarity: number;
  nearDuplicates: SimilarPair[];
  /** Lead verbs used by more than one candidate, with their keys. */
  sharedVerbs: { verb: string; keys: string[] }[];
}

/** Diversity of a spread, for the eval metrics (SYSTEM.md §8) and tests. */
export function diversity(items: readonly Comparable[]): Diversity {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      sum += similarity(items[i] as Comparable, items[j] as Comparable);
      n++;
    }
  const byVerb = new Map<string, string[]>();
  for (const c of items) {
    const v = leadVerb(c.identity);
    if (v) byVerb.set(v, [...(byVerb.get(v) ?? []), c.key]);
  }
  return {
    meanSimilarity: n === 0 ? 0 : Math.round((sum / n) * 1e6) / 1e6,
    nearDuplicates: nearDuplicates(items),
    sharedVerbs: [...byVerb]
      .filter(([, keys]) => keys.length > 1)
      .map(([verb, keys]) => ({ verb, keys: [...keys].sort() }))
      .sort((a, b) => (a.verb < b.verb ? -1 : 1)),
  };
}
