import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutField, neighbour, overlaps, readingOrder, type FieldPoint } from './field';
import {
  contentWords,
  diversity,
  jaccard,
  leadVerb,
  nearDuplicates,
  NEAR_DUPLICATE,
  similarity,
  stem,
  trigrams,
  words,
  type Comparable,
} from './similarity';

const c = (key: string, name: string, identity: string, description?: string): Comparable => ({
  key,
  name,
  identity,
  description,
});

const comparableArb = fc.record({
  key: fc.string({ minLength: 1, maxLength: 4 }),
  name: fc.string({ maxLength: 24 }),
  identity: fc.string({ maxLength: 60 }),
  description: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
});

describe('similarity', () => {
  it('normalises words and stems', () => {
    expect(words('Glass-Lung’s  ÉCHO!')).toEqual(['glass', 'lungs', 'echo']);
    expect(stem('glowing')).toBe('glow');
    expect(stem('glows')).toBe('glow');
    expect(stem('berries')).toBe('berry');
    expect(stem('is')).toBe('is');
    expect([...contentWords('It glows in the dark')]).toEqual(['glow', 'dark']);
    expect(trigrams('Glass Lung')).toEqual(trigrams('glasslung'));
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });

  it('scores near-duplicates high and different ideas low', () => {
    const a = c('a', 'Glass Lung', 'Lets you breathe the thin air of the high bands.');
    const b = c('b', 'Glasslung', 'Lets you breathe thin air in the high bands.');
    const d = c('d', 'Cinder Spur', 'Kicks off walls, leaving burning prints.');
    expect(similarity(a, b)).toBeGreaterThan(0.8);
    expect(similarity(a, d)).toBeLessThan(0.15);
    // Same idea, different name: still joined.
    const e = c('e', 'Thin Air Mask', 'Lets you breathe the thin air of high bands.');
    expect(similarity(a, e)).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
    expect(nearDuplicates([d, b, a, e]).map((p) => `${p.a}-${p.b}`)).toEqual(['a-b', 'a-e', 'b-e']);
  });

  it('property: symmetric, bounded, deterministic, and 1 for itself', () => {
    fc.assert(
      fc.property(comparableArb, comparableArb, (a, b) => {
        const s = similarity(a, b);
        expect(s).toBe(similarity(b, a));
        expect(s).toBe(similarity({ ...a }, { ...b }));
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        const self = similarity(a, a);
        const hasIdea = contentWords(`${a.identity} ${a.description ?? ''}`).size > 0;
        const hasName = words(a.name).length > 0;
        if (hasIdea && hasName) expect(self).toBe(1);
      }),
    );
  });

  it('property: the pair list does not depend on order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(comparableArb, { selector: (x) => x.key, maxLength: 10 }),
        fc.integer(),
        (items, seed) => {
          const shuffled = [...items].sort(
            (x, y) => ((x.key.charCodeAt(0) * seed) % 7) - ((y.key.charCodeAt(0) * seed) % 7),
          );
          expect(nearDuplicates(shuffled)).toEqual(nearDuplicates(items));
          for (const p of nearDuplicates(items, 0)) expect(p.a < p.b).toBe(true);
        },
      ),
    );
  });

  it('finds lead verbs and measures diversity', () => {
    expect(leadVerb('It hums when danger is near')).toBe('hum');
    expect(leadVerb('Hums softly')).toBe('hum');
    expect(leadVerb('the')).toBeUndefined();
    const d = diversity([
      c('a', 'One', 'It hums at night.'),
      c('b', 'Two', 'Hums in the rain.'),
      c('c', 'Three', 'Burns the ground.'),
    ]);
    expect(d.sharedVerbs).toEqual([{ verb: 'hum', keys: ['a', 'b'] }]);
    expect(d.meanSimilarity).toBeGreaterThan(0);
    expect(diversity([]).meanSimilarity).toBe(0);
  });
});

describe('field layout', () => {
  const box = { width: 1000, height: 600, cardW: 180, cardH: 52, gap: 8 };
  const pointArb = fc.record({
    key: fc.string({ minLength: 1, maxLength: 3 }),
    x: fc.double({ min: 0, max: 1, noNaN: true }),
    y: fc.double({ min: 0, max: 1, noNaN: true }),
  });

  it('maps axes to screen: x left→right, y bottom→top', () => {
    const [lo, hi] = layoutField(
      [
        { key: 'a', x: 0, y: 0 },
        { key: 'b', x: 1, y: 1 },
      ],
      box,
    );
    expect(lo).toEqual({ key: 'a', left: 8, top: 600 - 52 - 8 });
    expect(hi).toEqual({ key: 'b', left: 1000 - 180 - 8, top: 8 });
  });

  it('property: deterministic, order-independent, in bounds, and no overlap when there is room', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(pointArb, { selector: (p) => p.key, maxLength: 16 }),
        (pts: FieldPoint[]) => {
          const a = layoutField(pts, box);
          expect(layoutField([...pts].reverse(), box)).toEqual(a);
          for (const p of a) {
            expect(p.left).toBeGreaterThanOrEqual(8);
            expect(p.top).toBeGreaterThanOrEqual(8);
            expect(p.left).toBeLessThanOrEqual(1000 - 180 - 8);
            expect(p.top).toBeLessThanOrEqual(600 - 52 - 8);
          }
          for (let i = 0; i < a.length; i++)
            for (let j = i + 1; j < a.length; j++)
              expect(overlaps(a[i]!, a[j]!, 180, 52)).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('separates identical positions', () => {
    const a = layoutField(
      ['a', 'b', 'c'].map((key) => ({ key, x: 0.5, y: 0.5 })),
      box,
    );
    expect(overlaps(a[0]!, a[1]!, 180, 52)).toBe(false);
    expect(overlaps(a[1]!, a[2]!, 180, 52)).toBe(false);
  });

  it('navigates by direction and reading order', () => {
    const placed = [
      { key: 'a', left: 0, top: 0 },
      { key: 'b', left: 300, top: 10 },
      { key: 'c', left: 0, top: 200 },
      { key: 'd', left: 300, top: 300 },
    ];
    expect(neighbour(placed, 'a', 'right')).toBe('b');
    expect(neighbour(placed, 'a', 'down')).toBe('c');
    expect(neighbour(placed, 'a', 'up')).toBeUndefined();
    expect(neighbour(placed, 'd', 'left')).toBe('c');
    expect(neighbour(placed, 'd', 'up')).toBe('b');
    expect(neighbour(placed, 'zz', 'up')).toBeUndefined();
    expect(readingOrder(placed)).toEqual(['a', 'b', 'c', 'd']);
  });
});
