import { encode } from 'fast-png';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './png';

describe('png', () => {
  it('round-trips RGBA8 exactly and deterministically', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), (w, h) => {
        const data = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 31 + w * h) & 255);
        const bytes = encodePng({ width: w, height: h, data });
        expect(encodePng({ width: w, height: h, data })).toEqual(bytes);
        const back = decodePng(bytes);
        expect([back.width, back.height]).toEqual([w, h]);
        expect(back.data).toEqual(data);
      }),
      { numRuns: 30 },
    );
  });

  it('decodes grey, grey+alpha, RGB, 16-bit, low-depth and indexed PNGs to RGBA8', () => {
    const grey = decodePng(
      encode({ width: 2, height: 1, data: new Uint8Array([10, 200]), channels: 1, depth: 8 }),
    );
    expect([...grey.data]).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
    const ga = decodePng(
      encode({ width: 1, height: 1, data: new Uint8Array([9, 99]), channels: 2, depth: 8 }),
    );
    expect([...ga.data]).toEqual([9, 9, 9, 99]);
    const rgb = decodePng(
      encode({ width: 1, height: 1, data: new Uint8Array([1, 2, 3]), channels: 3, depth: 8 }),
    );
    expect([...rgb.data]).toEqual([1, 2, 3, 255]);
    const deep = decodePng(
      encode({
        width: 1,
        height: 1,
        data: new Uint16Array([65535, 0, 32896, 257]),
        channels: 4,
        depth: 16,
      }),
    );
    expect([...deep.data]).toEqual([255, 0, 128, 1]);
    const bits = decodePng(
      encode({ width: 4, height: 1, data: new Uint8Array([0b10100000]), channels: 1, depth: 1 }),
    );
    expect([...bits.data].filter((_, i) => i % 4 === 0)).toEqual([255, 0, 255, 0]);
    const idx = decodePng(
      encode({
        width: 2,
        height: 1,
        data: new Uint8Array([1, 0]),
        channels: 1,
        depth: 8,
        // Transparent entry first: fast-png's encoder writes a one-entry tRNS for indexed
        // images (we never encode indexed), so only a leading transparent entry is unambiguous.
        palette: [
          [8, 9, 10, 0],
          [5, 6, 7, 255],
        ],
      }),
    );
    expect([...idx.data]).toEqual([5, 6, 7, 255, 8, 9, 10, 0]);
    const idx3 = decodePng(
      encode({
        width: 1,
        height: 1,
        data: new Uint8Array([0]),
        channels: 1,
        depth: 8,
        palette: [[5, 6, 7]],
      }),
    );
    expect([...idx3.data]).toEqual([5, 6, 7, 255]);
  });

  it('rejects garbage and mismatched buffers', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/PNG/);
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8ClampedArray(3) })).toThrow(
      /bytes/,
    );
  });
});
