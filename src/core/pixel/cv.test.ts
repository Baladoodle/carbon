import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SQUARE3, components8, dilate, ellipseKernel, erode, open } from './cv';
import type { Mask } from './cv';

/** The definition: erosion = AND, dilation = OR over in-image kernel offsets (OpenCV's neutral border). */
function brute(m: Mask, k: Array<[number, number]>, op: 'erode' | 'dilate'): Uint8Array {
  const r = Math.floor(k.length / 2);
  const out = new Uint8Array(m.w * m.h);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      let v = op === 'erode' ? 1 : 0;
      k.forEach(([j1, j2], i) => {
        for (let j = j1; j < j2; j++) {
          const yy = y + i - r;
          const xx = x + j - r;
          if (yy < 0 || yy >= m.h || xx < 0 || xx >= m.w) continue;
          const p = m.data[yy * m.w + xx]!;
          v = op === 'erode' ? v & p : v | p;
        }
      });
      out[y * m.w + x] = v;
    }
  }
  return out;
}

const maskArb = fc
  .record({
    w: fc.integer({ min: 1, max: 90 }),
    h: fc.integer({ min: 1, max: 24 }),
    density: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .chain(({ w, h, density }) =>
    fc
      .array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: w * h, maxLength: w * h })
      .map((v): Mask => ({
        w,
        h,
        data: Uint8Array.from(v, (u) => (u < density ? 1 : 0)),
      })),
  );

describe('OpenCV morphology', () => {
  it('ellipse kernels match cv2.getStructuringElement(MORPH_ELLIPSE)', () => {
    // row widths printed by OpenCV 4.14 for radii 2..8
    const cv2: Record<number, number[]> = {
      2: [1, 5, 5, 5, 1],
      3: [1, 5, 7, 7, 7, 5, 1],
      4: [1, 7, 7, 9, 9, 9, 7, 7, 1],
      5: [1, 7, 9, 11, 11, 11, 11, 11, 9, 7, 1],
      8: [1, 9, 11, 13, 15, 15, 17, 17, 17, 17, 17, 15, 15, 13, 11, 9, 1],
    };
    for (const [r, widths] of Object.entries(cv2)) {
      expect(ellipseKernel(2 * Number(r) + 1).map(([a, b]) => b - a)).toEqual(widths);
    }
  });

  it('erode, dilate and open equal the definition (bit-packed rows, any width)', () => {
    fc.assert(
      fc.property(maskArb, fc.integer({ min: 0, max: 12 }), (m, r) => {
        const k = r === 0 ? SQUARE3 : ellipseKernel(2 * r + 1);
        expect(erode(m, k).data).toEqual(brute(m, k, 'erode'));
        expect(dilate(m, k).data).toEqual(brute(m, k, 'dilate'));
        expect(open(m, k).data).toEqual(brute({ ...m, data: brute(m, k, 'erode') }, k, 'dilate'));
      }),
      { numRuns: 300 },
    );
  });

  it('labels 8-connected components with boxes and areas', () => {
    const m: Mask = {
      w: 5,
      h: 3,
      data: Uint8Array.from([1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0]),
    };
    const cs = components8(m).map(({ left, top, width, height, area }) => ({
      left,
      top,
      width,
      height,
      area,
    }));
    expect(cs).toEqual([
      { left: 0, top: 0, width: 2, height: 2, area: 2 },
      { left: 4, top: 0, width: 1, height: 2, area: 2 },
    ]);
  });
});
