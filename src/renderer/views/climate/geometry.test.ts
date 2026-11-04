import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ClimateSchema } from '@core/model/fields';
import {
  area,
  climateOf,
  emptyRegions,
  emptyShare,
  HANDLES,
  intersect,
  MIN_SIZE,
  moveRect,
  newRegion,
  overlaps,
  rectOf,
  resizeRect,
  sameRect,
  type Rect,
} from './geometry';

const R = (x0: number, x1: number, y0: number, y1: number): Rect => ({ x0, x1, y0, y1 });

describe('overlaps', () => {
  it('finds shared climate between pairs, ignoring edges that only touch', () => {
    const out = overlaps([
      { id: 'b', rect: R(0.4, 0.8, 0.4, 0.8) },
      { id: 'a', rect: R(0, 0.5, 0, 0.5) },
      { id: 'c', rect: R(0.8, 1, 0, 1) },
    ]);
    expect(out).toEqual([{ a: 'a', b: 'b', rect: R(0.4, 0.5, 0.4, 0.5) }]);
    expect(intersect(R(0, 0.5, 0, 1), R(0.5, 1, 0, 1))).toBeNull();
  });
});

describe('emptyRegions', () => {
  it('is the whole plane with no regions, and nothing when covered', () => {
    expect(emptyRegions([])).toEqual([R(0, 1, 0, 1)]);
    expect(emptyRegions([R(0, 1, 0, 1)])).toEqual([]);
    expect(emptyShare([R(0, 0.5, 0, 1)])).toBeCloseTo(0.5);
  });

  it('merges free cells into few rectangles', () => {
    expect(emptyRegions([R(0.25, 0.75, 0.25, 0.75)])).toEqual([
      R(0, 1, 0, 0.25),
      R(0, 0.25, 0.25, 0.75),
      R(0.75, 1, 0.25, 0.75),
      R(0, 1, 0.75, 1),
    ]);
  });

  it('ignores parts of regions outside the plane', () => {
    expect(emptyRegions([R(-1, 0.5, -1, 2)])).toEqual([R(0.5, 1, 0, 1)]);
  });
});

/** Union area by coordinate compression (independent of emptyRegions). */
function unionArea(rects: Rect[]): number {
  const xs = [...new Set([0, 1, ...rects.flatMap((r) => [r.x0, r.x1])])].sort((a, b) => a - b);
  const ys = [...new Set([0, 1, ...rects.flatMap((r) => [r.y0, r.y1])])].sort((a, b) => a - b);
  let s = 0;
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = ((xs[i] ?? 0) + (xs[i + 1] ?? 0)) / 2;
      const cy = ((ys[j] ?? 0) + (ys[j + 1] ?? 0)) / 2;
      if (rects.some((r) => r.x0 <= cx && cx <= r.x1 && r.y0 <= cy && cy <= r.y1))
        s += ((xs[i + 1] ?? 0) - (xs[i] ?? 0)) * ((ys[j + 1] ?? 0) - (ys[j] ?? 0));
    }
  return s;
}

const unit = fc.integer({ min: 0, max: 20 }).map((n) => n / 20);
const rectArb: fc.Arbitrary<Rect> = fc
  .tuple(unit, unit, unit, unit)
  .filter(([a, b, c, d]) => a !== b && c !== d)
  .map(([a, b, c, d]) => R(Math.min(a, b), Math.max(a, b), Math.min(c, d), Math.max(c, d)));

describe('geometry properties', () => {
  it('empty regions are disjoint, uncovered, and fill exactly what the regions leave', () => {
    fc.assert(
      fc.property(fc.array(rectArb, { maxLength: 6 }), (rects) => {
        const empty = emptyRegions(rects);
        for (const e of empty) {
          expect(e.x0).toBeGreaterThanOrEqual(0);
          expect(e.y1).toBeLessThanOrEqual(1);
          for (const r of rects) expect(intersect(e, r)).toBeNull();
        }
        for (let i = 0; i < empty.length; i++)
          for (let j = i + 1; j < empty.length; j++)
            expect(intersect(empty[i] ?? R(0, 0, 0, 0), empty[j] ?? R(0, 0, 0, 0))).toBeNull();
        expect(empty.reduce((s, e) => s + area(e), 0) + unionArea(rects)).toBeCloseTo(1, 9);
      }),
      { numRuns: 300 },
    );
  });

  it('moving and resizing keep a valid climate inside the plane', () => {
    const delta = fc.double({ min: -1.5, max: 1.5, noNaN: true });
    fc.assert(
      fc.property(rectArb, delta, delta, fc.constantFrom(...HANDLES), (r, dx, dy, h) => {
        for (const out of [moveRect(r, dx, dy), resizeRect(r, h, dx, dy)]) {
          expect(ClimateSchema.safeParse(climateOf(out)).success).toBe(true);
          expect(out.x0).toBeGreaterThanOrEqual(0);
          expect(out.x1).toBeLessThanOrEqual(1);
          expect(out.y0).toBeGreaterThanOrEqual(0);
          expect(out.y1).toBeLessThanOrEqual(1);
        }
        const m = moveRect(r, dx, dy);
        expect(m.x1 - m.x0).toBeCloseTo(r.x1 - r.x0, 6);
        expect(m.y1 - m.y0).toBeCloseTo(r.y1 - r.y0, 6);
        const z = resizeRect(r, h, dx, dy);
        expect(z.x1 - z.x0).toBeGreaterThanOrEqual(Math.min(MIN_SIZE, r.x1 - r.x0) - 1e-9);
        expect(z.y1 - z.y0).toBeGreaterThanOrEqual(Math.min(MIN_SIZE, r.y1 - r.y0) - 1e-9);
        expect(sameRect(moveRect(r, 0, 0), r)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('a new region sits in the largest empty area when there is room', () => {
    fc.assert(
      fc.property(fc.array(rectArb, { maxLength: 4 }), (rects) => {
        const n = newRegion(rects);
        expect(ClimateSchema.safeParse(climateOf(n)).success).toBe(true);
        const biggest = emptyRegions(rects).sort((a, b) => area(b) - area(a))[0];
        if (biggest && biggest.x1 - biggest.x0 >= 0.2 && biggest.y1 - biggest.y0 >= 0.2)
          for (const r of rects) expect(intersect(n, r)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});

describe('drag maths', () => {
  it('snaps to hundredths and clamps', () => {
    expect(moveRect(R(0.1, 0.3, 0.1, 0.3), 0.123, -0.5)).toEqual(R(0.22, 0.42, 0, 0.2));
    expect(moveRect(R(0.1, 0.3, 0.1, 0.3), 2, 2)).toEqual(R(0.8, 1, 0.8, 1));
    expect(resizeRect(R(0.1, 0.3, 0.1, 0.3), 'ne', 0.1, 0.1)).toEqual(R(0.1, 0.4, 0.1, 0.4));
    expect(resizeRect(R(0.1, 0.3, 0.1, 0.3), 'sw', 0.5, 0.5)).toEqual(R(0.25, 0.3, 0.25, 0.3));
    expect(resizeRect(R(0.1, 0.3, 0.1, 0.3), 'w', -1, 0)).toEqual(R(0, 0.3, 0.1, 0.3));
    expect(newRegion([])).toEqual(R(0.4, 0.6, 0.4, 0.6));
    expect(rectOf(climateOf(R(0.1, 0.2, 0.3, 0.4)))).toEqual(R(0.1, 0.2, 0.3, 0.4));
  });
});
