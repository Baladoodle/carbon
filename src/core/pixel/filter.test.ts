import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { filterImage, linearToByte, srgbToLinear } from './filter';
import { medianCut, quantize } from './quantize';
import { PRESET_SETTINGS, resolveSettings } from './presets';
import { PIXEL_PRESETS } from './types';
import type { PixelPreset, RgbaImage } from './types';

const img = (width: number, height: number, f: (x: number, y: number) => number[]): RgbaImage => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(f(x, y), (y * width + x) * 4);
  return { width, height, data };
};

const imageArb = fc
  .record({ w: fc.integer({ min: 1, max: 40 }), h: fc.integer({ min: 1, max: 40 }) })
  .chain(({ w, h }) =>
    fc
      .uint8Array({ minLength: w * h * 4, maxLength: w * h * 4 })
      .map((bytes): RgbaImage => ({ width: w, height: h, data: new Uint8ClampedArray(bytes) })),
  );
const targetArb = fc.record({
  w: fc.integer({ min: 1, max: 32 }),
  h: fc.integer({ min: 1, max: 32 }),
});
const presetArb = fc.constantFrom(...PIXEL_PRESETS);

describe('filterImage properties', () => {
  it('is deterministic, exact-sized, in range, and NaN-free', () => {
    fc.assert(
      fc.property(imageArb, targetArb, presetArb, (src, target, preset) => {
        const a = filterImage(src, { target, preset });
        const b = filterImage(src, { target, preset });
        expect(a.image.width).toBe(target.w);
        expect(a.image.height).toBe(target.h);
        expect(a.image.data.length).toBe(target.w * target.h * 4);
        expect(a.image.data).toEqual(b.image.data);
        for (const v of a.image.data) expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
        expect(Number.isFinite(a.report.colors)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it('does not mutate its input', () => {
    fc.assert(
      fc.property(imageArb, presetArb, (src, preset) => {
        const before = src.data.slice();
        filterImage(src, { target: { w: 7, h: 5 }, preset });
        expect(src.data).toEqual(before);
      }),
      { numRuns: 50 },
    );
  });

  it('cuts alpha to 0 or 255 for presets with a threshold, and texture is opaque', () => {
    fc.assert(
      fc.property(imageArb, targetArb, presetArb, (src, target, preset) => {
        const { image, report } = filterImage(src, { target, preset });
        for (let p = 3; p < image.data.length; p += 4) {
          if (report.settings.alphaThreshold !== null) expect([0, 255]).toContain(image.data[p]);
          if (report.settings.tileable) expect(image.data[p]).toBe(255);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('respects the palette size', () => {
    fc.assert(
      fc.property(imageArb, targetArb, presetArb, (src, target, preset) => {
        const { report } = filterImage(src, { target, preset });
        if (report.settings.paletteSize !== null) {
          expect(report.colors).toBeLessThanOrEqual(report.settings.paletteSize);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('is idempotent at the same size for presets without a rim', () => {
    const presets = PIXEL_PRESETS.filter((p) => PRESET_SETTINGS[p].rim === 0);
    expect(presets).toEqual(['sprite', 'texture', 'none']);
    fc.assert(
      fc.property(imageArb, targetArb, fc.constantFrom(...presets), (src, target, preset) => {
        const once = filterImage(src, { target, preset }).image;
        const twice = filterImage(once, { target, preset }).image;
        expect(twice.data).toEqual(once.data);
      }),
      { numRuns: 100 },
    );
  });

  it('gives transparent pixels canonical zero colour', () => {
    fc.assert(
      fc.property(imageArb, targetArb, presetArb, (src, target, preset) => {
        const d = filterImage(src, { target, preset }).image.data;
        for (let p = 0; p < d.length; p += 4) {
          if (d[p + 3] === 0) expect([d[p], d[p + 1], d[p + 2]]).toEqual([0, 0, 0]);
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe('filterImage stages', () => {
  it('none at the same size is the identity on opaque images', () => {
    const src = img(5, 3, (x, y) => [x * 40, y * 80, 7, 255]);
    expect(filterImage(src, { target: { w: 5, h: 3 }, preset: 'none' }).image.data).toEqual(
      src.data,
    );
  });

  it('averages in linear light when asked', () => {
    const src = img(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const gamma = filterImage(src, { target: { w: 1, h: 1 }, preset: 'none' }).image.data;
    const linear = filterImage(src, {
      target: { w: 1, h: 1 },
      preset: 'none',
      settings: { linearLight: true },
    }).image.data;
    expect(gamma[0]).toBe(128);
    expect(linear[0]).toBe(188); // sRGB(0.5) = 187.5 → 188
  });

  it('halo fix keeps transparent black out of edge colour', () => {
    const src = img(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [200, 100, 50, 255]));
    const on = filterImage(src, {
      target: { w: 1, h: 1 },
      preset: 'none',
      settings: { haloFix: true },
    });
    const off = filterImage(src, { target: { w: 1, h: 1 }, preset: 'none' });
    expect([...on.image.data]).toEqual([200, 100, 50, 128]);
    expect(off.image.data[0]).toBe(100);
  });

  it('uses exact fractional area weights', () => {
    const src = img(3, 1, (x) => [x === 1 ? 255 : 0, 0, 0, 255]);
    const d = filterImage(src, { target: { w: 2, h: 1 }, preset: 'none' }).image.data;
    // each output covers 1.5 source px: [0, half of 255] → 255 * 0.5/1.5 = 85
    expect([d[0], d[4]]).toEqual([85, 85]);
  });

  it('item darkens the outer rim and keeps the interior', () => {
    const src = img(5, 5, () => [200, 200, 200, 255]);
    const d = filterImage(src, { target: { w: 5, h: 5 }, preset: 'item' }).image.data;
    expect(d[0]).toBe(150); // edge pixel, 200 * 0.75
    expect(d[(2 * 5 + 2) * 4]).toBe(200); // centre
  });

  it('reports what it did', () => {
    const src = img(4, 4, (x) => [x * 60, 0, 0, x < 2 ? 0 : 255]);
    const { report } = filterImage(src, { target: { w: 2, h: 2 }, preset: 'sprite' });
    expect(report).toMatchObject({
      preset: 'sprite',
      source: { w: 4, h: 4 },
      target: { w: 2, h: 2 },
      opaquePixels: 2,
      colors: 1,
      provisional: true,
      upstream: null,
    });
  });

  it('rejects bad input', () => {
    const src = img(2, 2, () => [0, 0, 0, 255]);
    expect(() => filterImage(src, { target: { w: 0, h: 4 }, preset: 'item' })).toThrow(/target/);
    expect(() => filterImage(src, { target: { w: 1.5, h: 4 }, preset: 'item' })).toThrow(/target/);
    expect(() =>
      filterImage(
        { ...src, data: new Uint8ClampedArray(3) },
        { target: { w: 1, h: 1 }, preset: 'item' },
      ),
    ).toThrow(/bytes/);
    expect(() =>
      filterImage(
        { width: 0, height: 1, data: new Uint8ClampedArray(0) },
        { target: { w: 1, h: 1 }, preset: 'item' },
      ),
    ).toThrow(/source size/);
    expect(() =>
      filterImage(src, { target: { w: 1, h: 1 }, preset: 'bogus' as PixelPreset }),
    ).toThrow(/preset/);
    expect(() => resolveSettings('item', { alphaThreshold: 2 })).toThrow(/alphaThreshold/);
    expect(() => resolveSettings('item', { paletteSize: 0 })).toThrow(/paletteSize/);
    expect(() => resolveSettings('item', { rim: -1 })).toThrow(/rim/);
  });

  it('ignores undefined overrides', () => {
    expect(resolveSettings('item', { rim: undefined })).toEqual(PRESET_SETTINGS.item);
  });
});

describe('colour helpers', () => {
  it('sRGB round-trips every byte', () => {
    for (let i = 0; i < 256; i++) expect(linearToByte(srgbToLinear(i))).toBe(i);
    expect(linearToByte(-1)).toBe(0);
    expect(linearToByte(2)).toBe(255);
  });
});

describe('quantize', () => {
  it('leaves images with few colours alone and caps many', () => {
    const d = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) d.set([i * 4, 255 - i * 4, (i * 37) & 255, 255], i * 4);
    const copy = d.slice();
    quantize(copy, 64);
    expect(copy).toEqual(d);
    quantize(copy, 5);
    const seen = new Set<string>();
    for (let p = 0; p < copy.length; p += 4) seen.add(`${copy[p]},${copy[p + 1]},${copy[p + 2]}`);
    expect(seen.size).toBeLessThanOrEqual(5);
  });

  it('stops splitting when boxes are single colours', () => {
    expect(
      medianCut(
        new Map([
          [0x000000, 1],
          [0xffffff, 1],
          [0x808080, 1],
        ]),
        2,
      ),
    ).toHaveLength(2);
  });
});
