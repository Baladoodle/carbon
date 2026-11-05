import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { editIntent, nextIntentX, type IntentEdit } from './curves';

/** Intent curves you add points to and delete points from (review-b, integrate §10 gap). */

const bands = {
  axis: 'band' as const,
  domain: [0, 4] as [number, number],
  ticks: [0, 1, 2, 3, 4].map((x) => ({ x, label: `b${x}`, band: `b${x}` })),
};
const attr = {
  axis: 'attribute' as const,
  domain: [0, 100] as [number, number],
  ticks: [],
};

describe('editIntent', () => {
  it('adds a point on bands at the nearest tick, and replaces one already there', () => {
    const p = [
      { x: 0, y: 1 },
      { x: 4, y: 5 },
    ];
    expect(editIntent(p, { type: 'add', x: 1.7, y: 3 }, bands)).toEqual([
      { x: 0, y: 1 },
      { x: 2, y: 3 },
      { x: 4, y: 5 },
    ]);
    expect(editIntent(p, { type: 'add', x: 3.9, y: 9 }, bands)).toEqual([
      { x: 0, y: 1 },
      { x: 4, y: 9 },
    ]);
    expect(editIntent(p, { type: 'add', x: 99, y: 9 }, bands)).toEqual([
      { x: 0, y: 1 },
      { x: 4, y: 9 },
    ]);
  });

  it('adds on an attribute axis anywhere in its range, clamped', () => {
    expect(editIntent([], { type: 'add', x: 33.3, y: 2 }, attr)).toEqual([{ x: 33.3, y: 2 }]);
    expect(editIntent([], { type: 'add', x: -5, y: 2 }, attr)).toEqual([{ x: 0, y: 2 }]);
    expect(editIntent([], { type: 'add', x: Number.NaN, y: 2 }, attr)).toEqual([]);
    expect(editIntent([], { type: 'add', x: 4, y: Infinity }, attr)).toEqual([]);
  });

  it('moves in x and y, never past or onto a neighbour', () => {
    const p = [
      { x: 10, y: 1 },
      { x: 50, y: 2 },
      { x: 90, y: 3 },
    ];
    expect(editIntent(p, { type: 'move', index: 1, x: 60, y: 7 }, attr)[1]).toEqual({
      x: 60,
      y: 7,
    });
    // Past the next point: the x move is ignored, the y move kept.
    expect(editIntent(p, { type: 'move', index: 1, x: 95, y: 7 }, attr)[1]).toEqual({
      x: 50,
      y: 7,
    });
    expect(editIntent(p, { type: 'move', index: 1, x: 90 }, attr)[1]).toEqual({ x: 50, y: 2 });
    const b = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    expect(editIntent(b, { type: 'move', index: 0, x: 0.2 }, bands)[0]).toEqual({ x: 0, y: 1 });
    expect(editIntent(b, { type: 'move', index: 0, x: 2.1 }, bands)[0]).toEqual({ x: 1, y: 1 });
  });

  it('removes a point; removing the last leaves none', () => {
    expect(editIntent([{ x: 1, y: 1 }], { type: 'remove', index: 0 }, bands)).toEqual([]);
    expect(
      editIntent(
        [
          { x: 1, y: 1 },
          { x: 3, y: 3 },
        ],
        { type: 'remove', index: 1 },
        bands,
      ),
    ).toEqual([{ x: 1, y: 1 }]);
  });

  it('always leaves points sorted, unique, in range and on ticks (property)', () => {
    const edit: fc.Arbitrary<IntentEdit> = fc.oneof(
      fc.record({
        type: fc.constant('add' as const),
        x: fc.double({ min: -50, max: 150, noNaN: true }),
        y: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      }),
      fc.record(
        {
          type: fc.constant('move' as const),
          index: fc.nat(8),
          x: fc.double({ min: -50, max: 150, noNaN: true }),
          y: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        },
        { requiredKeys: ['type', 'index'] },
      ),
      fc.record({ type: fc.constant('remove' as const), index: fc.nat(8) }),
    );
    fc.assert(
      fc.property(fc.constantFrom(bands, attr), fc.array(edit, { maxLength: 30 }), (s, edits) => {
        let p: { x: number; y: number }[] = [];
        for (const e of edits) {
          p = editIntent(p, e, s);
          for (let i = 0; i < p.length; i++) {
            const q = p[i] as { x: number; y: number };
            expect(q.x).toBeGreaterThanOrEqual(s.domain[0]);
            expect(q.x).toBeLessThanOrEqual(s.domain[1]);
            expect(Number.isFinite(q.y)).toBe(true);
            if (s.axis === 'band') expect(Number.isInteger(q.x)).toBe(true);
            if (i > 0) expect(q.x).toBeGreaterThan((p[i - 1] as { x: number }).x);
          }
        }
      }),
    );
  });
});

describe('nextIntentX: where a keyboard add puts the new point', () => {
  it('bands: the next free tick to the right, else to the left', () => {
    const p = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 4, y: 1 },
    ];
    expect(nextIntentX(p, 0, bands)).toBe(3);
    expect(nextIntentX(p, 2, bands)).toBe(3);
    const full = [0, 1, 2, 3, 4].map((x) => ({ x, y: 0 }));
    expect(nextIntentX(full, 2, bands)).toBeNull();
  });
  it('attributes: halfway to the next point or the range end, else to the previous', () => {
    expect(nextIntentX([{ x: 20, y: 0 }], 0, attr)).toBe(60);
    expect(
      nextIntentX(
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        1,
        attr,
      ),
    ).toBe(50);
    expect(nextIntentX([{ x: 5, y: 0 }], 9, attr)).toBeNull();
  });
});
