import { describe, expect, it } from 'vitest';
import { hsvToRgb, pairwiseSum, pyMod, rgbToHsv, roundHalfEven } from './py';

describe('Python and NumPy semantics', () => {
  it('rounds half to even like round() and np.rint', () => {
    expect(
      [0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001, 89.25].map((v) => roundHalfEven(v) + 0),
    ).toEqual([0, 2, 2, 0, -2, 2, 3, 89]);
  });

  it('takes float modulo with the sign of the divisor', () => {
    expect(pyMod(-0.25, 1)).toBe(0.75);
    expect(pyMod(7.5, 6)).toBe(1.5);
    expect(pyMod(-6, 6)).toBe(0);
    expect(pyMod(-13, 6)).toBe(5);
  });

  it('matches colorsys round trips and known values', () => {
    expect(rgbToHsv(1, 0, 0)).toEqual([0, 1, 1]);
    expect(rgbToHsv(0.5, 0.5, 0.5)).toEqual([0, 0, 0.5]);
    expect(rgbToHsv(0, 0, 1)[0]).toBeCloseTo(2 / 3, 15);
    expect(rgbToHsv(1, 0, 0.5)[0]).toBeCloseTo(11 / 12, 15);
    for (const [r, g, b] of [
      [0.2, 0.4, 0.6],
      [0.9, 0.1, 0.3],
      [0.3, 0.8, 0.1],
    ] as const) {
      const back = hsvToRgb(...rgbToHsv(r, g, b));
      back.forEach((v, i) => expect(v).toBeCloseTo([r, g, b][i]!, 12));
    }
    expect(hsvToRgb(0.5, 0, 0.3)).toEqual([0.3, 0.3, 0.3]);
  });

  it('sums pairwise like NumPy: exact on integers, blockwise for long runs', () => {
    const ints = Array.from({ length: 1000 }, (_, i) => i % 7);
    expect(pairwiseSum(ints, 0, ints.length)).toBe(ints.reduce((a, b) => a + b, 0));
    expect(pairwiseSum([1, 2, 3], 1, 2)).toBe(5);
    // float32 order matters: 2^24 + 1 + 1 … sequentially stays 2^24, pairwise does not
    const big = [16777216, ...Array<number>(15).fill(1)];
    expect(pairwiseSum(big, 0, big.length, Math.fround)).toBe(16777216 + 14);
  });
});
