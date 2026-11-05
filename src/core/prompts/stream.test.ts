import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { JsonArrayStreamer } from './stream';

/**
 * The streaming partial-JSON parser for spreads (review-b): arbitrary JSON in
 * the items and around them, decoy keys, strings full of brackets, quotes,
 * escapes and astral characters, pretty-printed or compact, split at every
 * kind of chunk boundary (including inside escapes and surrogate pairs).
 */

const nasty = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc.constantFrom('{', '}', '[', ']', '"', '\\', '\\"', '"candidates":[', '😀', ' ', ':', ','),
);
const json: fc.Arbitrary<unknown> = fc.letrec<{ v: unknown }>((tie) => ({
  v: fc.oneof(
    { depthSize: 'small' },
    nasty,
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('v'), { maxLength: 3 }),
    fc.dictionary(fc.oneof(nasty, fc.constant('candidates')), tie('v'), { maxKeys: 3 }),
  ),
})).v;
/** The array's items are objects or arrays (candidates are objects). */
const item = fc.oneof(
  fc.dictionary(fc.oneof(nasty, fc.constant('candidates')), json, { maxKeys: 4 }),
  fc.array(json, { maxLength: 3 }),
);

/** Splits text into chunks at the given cut lengths (cycled), down to single characters. */
function chunks(text: string, cuts: number[]): string[] {
  const out: string[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const n = cuts[k++ % cuts.length] ?? 1;
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

describe('JsonArrayStreamer under arbitrary JSON and arbitrary chunking', () => {
  it('yields exactly the array’s items, in order, each once, equal to a full parse', () => {
    fc.assert(
      fc.property(
        fc.array(item, { maxLength: 6 }),
        fc.dictionary(nasty, json, { maxKeys: 3 }),
        fc.dictionary(nasty, json, { maxKeys: 3 }),
        fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 20 }),
        fc.boolean(),
        (items, before, after, cuts, pretty) => {
          // Decoys first (a nested "candidates" key included), the array, then more.
          const doc: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(before))
            if (k !== 'candidates') doc[k] = v;
          doc.decoy = { candidates: [{ not: 'this one' }] };
          doc.candidates = items;
          for (const [k, v] of Object.entries(after)) if (!(k in doc)) doc[k] = v;
          const text = pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc);
          const expected = (JSON.parse(text) as { candidates: unknown[] }).candidates;
          const s = new JsonArrayStreamer('candidates');
          const got: unknown[] = [];
          for (const c of chunks(text, cuts)) got.push(...s.push(c));
          expect(got).toEqual(expected);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('an item is yielded as soon as its closing bracket arrives, never before', () => {
    fc.assert(
      fc.property(fc.array(item, { minLength: 1, maxLength: 4 }), (items) => {
        const text = JSON.stringify({ candidates: items });
        const s = new JsonArrayStreamer('candidates');
        let seen = 0;
        for (let i = 0; i < text.length; i++) {
          seen += s.push(text.charAt(i)).length;
          // Everything up to here, closed off, parses to at least `seen` items.
          const prefix = text.slice(0, i + 1);
          const complete = items.filter((_, n) => {
            const upTo = JSON.stringify({ candidates: items.slice(0, n + 1) }).slice(0, -2);
            return prefix.length >= upTo.length;
          }).length;
          expect(seen).toBe(complete);
        }
        expect(seen).toBe(items.length);
      }),
      { numRuns: 300 },
    );
  });

  it('a truncated stream yields only the complete items, and nothing malformed', () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 5 }), fc.nat(), (items, cutAt) => {
        const text = JSON.stringify({ candidates: items });
        const cut = text.slice(0, cutAt % (text.length + 1));
        const got = new JsonArrayStreamer('candidates').push(cut);
        expect(got).toEqual(items.slice(0, got.length));
      }),
      { numRuns: 500 },
    );
  });
});
