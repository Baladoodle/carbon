import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matchQuery, matchWord, rank } from './fuzzy';

const labels = (q: string, items: string[]): string[] =>
  rank(
    q,
    items.map((label) => ({ label })),
  ).map((r) => r.item.label);

describe('matchWord', () => {
  it('matches subsequences case-insensitively and finds the positions', () => {
    expect(matchWord('gl', 'Glass Lung')?.positions).toEqual([0, 1]);
    expect(matchWord('glu', 'Glass Lung')?.positions).toEqual([0, 6, 7]);
    expect(matchWord('xyz', 'Glass Lung')).toBeNull();
    expect(matchWord('', 'x')).toEqual({ score: 0, positions: [] });
  });

  it('prefers word starts and runs over scattered letters', () => {
    // "cl" at the start of "Cloud" beats c…l scattered in "Cinder Sling".
    expect(labels('cl', ['Cinder Sling', 'Cloud Anklet'])).toEqual([
      'Cloud Anklet',
      'Cinder Sling',
    ]);
    // Initials: "vgv" finds Vent Glass Visor.
    expect(labels('vgv', ['Vent Glass Visor', 'Vague grave'])[0]).toBe('Vent Glass Visor');
  });

  it('exact and prefix matches win', () => {
    expect(labels('glide', ['Glide path', 'Glide', 'Go slide'])).toEqual([
      'Glide',
      'Glide path',
      'Go slide',
    ]);
  });

  it('property: every returned position matches the query in order', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5 }), fc.string({ maxLength: 30 }), (q, t) => {
        const m = matchWord(q, t);
        if (!m) return true;
        const chars = m.positions.map((p) => (t[p] ?? '').toLowerCase()).join('');
        return (
          chars === q.toLowerCase() &&
          m.positions.every((p, i) => i === 0 || p > (m.positions[i - 1] ?? -1))
        );
      }),
      { numRuns: 500 },
    );
  });

  it('property: a match exists exactly when the query is a subsequence', () => {
    const isSub = (q: string, t: string): boolean => {
      let k = 0;
      for (const c of t.toLowerCase()) if (c === q.toLowerCase()[k]) k++;
      return k === q.length;
    };
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-c]{0,4}$/),
        fc.stringMatching(/^[a-cA-C ]{0,12}$/),
        (q, t) => (matchWord(q, t) !== null) === isSub(q, t),
      ),
      { numRuns: 500 },
    );
  });
});

describe('matchQuery and rank', () => {
  it('every word must match, in the label or a term', () => {
    expect(matchQuery('item lung', { label: 'Glass Lung', terms: ['item'] })).not.toBeNull();
    expect(matchQuery('band lung', { label: 'Glass Lung', terms: ['item'] })).toBeNull();
  });

  it('a label match outranks a term-only match', () => {
    const r = rank('item', [
      { label: 'Glass Lung', terms: ['item'] },
      { label: 'Item drop rate', terms: ['action'] },
    ]);
    expect(r[0]?.item.label).toBe('Item drop rate');
  });

  it('the whole query against the label ranks multi-word names', () => {
    expect(labels('glass lu', ['Lung of glass', 'Glass Lung'])[0]).toBe('Glass Lung');
  });

  it('boosts (recent use) break near ties, and ranking is stable', () => {
    const items = [{ label: 'Go to Column' }, { label: 'Go to Climate' }];
    // Equal scores: the shorter label first …
    expect(rank('go', items).map((r) => r.item.label)).toEqual(['Go to Column', 'Go to Climate']);
    // … unless the other was used recently.
    expect(rank('go', items, (i) => (i.label === 'Go to Climate' ? 5 : 0))[0]?.item.label).toBe(
      'Go to Climate',
    );
  });

  it('an empty query matches everything with score 0', () => {
    expect(rank('', [{ label: 'b' }, { label: 'a' }]).map((r) => r.item.label)).toEqual(['a', 'b']);
  });
});
