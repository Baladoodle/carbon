/**
 * Properties of the ported filter. Pixel values themselves are pinned by
 * parity.test.ts against the real Genforge; these hold for any input.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { filterImage } from './filter';
import { PRESET_SETTINGS, UPSTREAM_REVISION } from './presets';
import { PIXEL_PRESETS } from './types';
import type { PixelPreset, PixelSettings, RgbaImage } from './types';

/** Random sprites: blobs of colour on transparency, with soft and hard alpha. */
const imageArb = fc
  .record({
    w: fc.integer({ min: 1, max: 48 }),
    h: fc.integer({ min: 1, max: 48 }),
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    soft: fc.boolean(),
  })
  .map(({ w, h, seed, soft }): RgbaImage => {
    let s = seed;
    const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const data = new Uint8ClampedArray(w * h * 4);
    const blobs = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
      x: rnd() * w,
      y: rnd() * h,
      r: 1 + rnd() * Math.max(w, h) * 0.5,
      c: [rnd() * 255, rnd() * 255, rnd() * 255],
    }));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (const b of blobs) {
          const d = Math.hypot(x - b.x, y - b.y) / b.r;
          if (d < 1) data.set([...b.c, soft ? 255 * (1 - d) : 255], (y * w + x) * 4);
        }
      }
    }
    return { width: w, height: h, data };
  });
const sizeArb = fc.integer({ min: 1, max: 32 });
const presetArb = fc.constantFrom(...PIXEL_PRESETS);
const target = (preset: PixelPreset, w: number, h: number): { w: number; h: number } =>
  preset === 'item' ? { w, h: w } : { w, h };

describe('filterImage properties', () => {
  it('is deterministic, exact-sized, in range, and leaves its input alone', () => {
    fc.assert(
      fc.property(imageArb, sizeArb, sizeArb, presetArb, (src, w, h, preset) => {
        const before = src.data.slice();
        const t = target(preset, w, h);
        const a = filterImage(src, { target: t, preset });
        const b = filterImage(src, { target: t, preset });
        expect([a.image.width, a.image.height, a.image.data.length]).toEqual([
          t.w,
          t.h,
          t.w * t.h * 4,
        ]);
        expect(a.image.data).toEqual(b.image.data);
        expect(a.report).toEqual(b.report);
        for (const v of a.image.data) expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
        expect(src.data).toEqual(before);
      }),
      { numRuns: 120 },
    );
  });

  it('gives binary alpha and zero colour on transparent pixels for item, sprite and texture', () => {
    fc.assert(
      fc.property(
        imageArb,
        sizeArb,
        sizeArb,
        fc.constantFrom<PixelPreset>('item', 'sprite', 'texture'),
        (src, w, h, preset) => {
          const d = filterImage(src, { target: target(preset, w, h), preset }).image.data;
          for (let p = 0; p < d.length; p += 4) {
            expect([0, 255]).toContain(d[p + 3]);
            if (d[p + 3] === 0) expect([d[p], d[p + 1], d[p + 2]]).toEqual([0, 0, 0]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('keeps texture within its 16-colour palette (no outline stage adds shades)', () => {
    fc.assert(
      fc.property(imageArb, sizeArb, sizeArb, (src, w, h) => {
        expect(
          filterImage(src, { target: { w, h }, preset: 'texture' }).report.colors,
        ).toBeLessThanOrEqual(16);
      }),
      { numRuns: 60 },
    );
  });

  it('is idempotent for none, the only preset Genforge itself is idempotent for', () => {
    // Measured on Genforge: none 0/138 differ on a second pass; item 136, sprite 99, texture 40.
    fc.assert(
      fc.property(imageArb, sizeArb, sizeArb, (src, w, h) => {
        const once = filterImage(src, { target: { w, h }, preset: 'none' }).image;
        expect(filterImage(once, { target: { w, h }, preset: 'none' }).image.data).toEqual(
          once.data,
        );
      }),
      { numRuns: 60 },
    );
  });

  it('snaps every opaque pixel onto an explicit palette, outline shades included', () => {
    const palette = ['#101820', '#c04030', '#f0d080', '#30a050'];
    const allowed = new Set(palette.map((c) => parseInt(c.slice(1), 16)));
    fc.assert(
      fc.property(
        imageArb,
        fc.constantFrom<PixelPreset>('item', 'sprite', 'texture'),
        (src, preset) => {
          const settings = {
            ...PRESET_SETTINGS[preset],
            colors: { count: 16, palette },
          } as PixelSettings;
          const d = filterImage(src, { target: { w: 16, h: 16 }, preset, settings }).image.data;
          for (let p = 0; p < d.length; p += 4) {
            if (d[p + 3])
              expect(
                allowed.has(((d[p] ?? 0) << 16) | ((d[p + 1] ?? 0) << 8) | (d[p + 2] ?? 0)),
              ).toBe(true);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('filterImage contract', () => {
  const src: RgbaImage = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) };

  it('reports the preset, the settings that ran and the upstream revision', () => {
    const { report } = filterImage(src, { target: { w: 2, h: 2 }, preset: 'sprite' });
    expect(report).toEqual({
      preset: 'sprite',
      settings: PRESET_SETTINGS.sprite,
      source: { w: 4, h: 4 },
      target: { w: 2, h: 2 },
      colors: report.colors,
      opaquePixels: report.opaquePixels,
      upstream: UPSTREAM_REVISION,
    });
    expect(filterImage(src, { target: { w: 2, h: 2 }, preset: 'none' }).report.settings).toBeNull();
  });

  it('uses Genforge presets verbatim (genforge/plans.py)', () => {
    expect(PRESET_SETTINGS).toEqual({
      item: { downscale: 'item', colors: { count: 16 }, hairlines: true },
      sprite: {
        downscale: 'edge_preserving',
        colors: { count: 16, pick: 'variance' },
        outline: 'rim',
      },
      texture: { downscale: 'area', colors: { count: 16, pick: 'variance' }, outline: 'none' },
      none: null,
    });
  });

  it('none at the same size is a copy, and upscales by nearest neighbour', () => {
    const img: RgbaImage = {
      width: 2,
      height: 1,
      data: Uint8ClampedArray.from([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    expect([...filterImage(img, { target: { w: 2, h: 1 }, preset: 'none' }).image.data]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect([...filterImage(img, { target: { w: 4, h: 1 }, preset: 'none' }).image.data]).toEqual([
      1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8,
    ]);
  });

  it('runs the other staged modes: hard and inner outlines, nearest, cleanup, a threshold', () => {
    const blob: RgbaImage = {
      width: 8,
      height: 8,
      data: Uint8ClampedArray.from({ length: 256 }, (_, i) =>
        i % 4 === 3 ? (i % 12 < 6 ? 255 : 0) : (i * 37) & 255,
      ),
    };
    for (const settings of [
      { downscale: 'area', outline: { mode: 'hard', color: '#ff0000' } },
      { downscale: 'area', outline: 'hard' },
      { downscale: 'nearest', outline: { mode: 'inner', darken: 0.5 }, cleanup: { stray: true } },
      { downscale: 'edge_preserving', colors: 8, cleanup: { min_cluster: 3 }, alpha: 0.25 },
      { downscale: 'area', colors: { count: 6, pick: 'range' }, outline: 'rim' },
    ] as PixelSettings[]) {
      const { image } = filterImage(blob, { target: { w: 6, h: 6 }, preset: 'texture', settings });
      expect(image.data.length).toBe(144);
    }
    const hard = filterImage(blob, {
      target: { w: 6, h: 6 },
      preset: 'texture',
      settings: { downscale: 'area', outline: { mode: 'hard', color: '#ff0000' } },
    }).image.data;
    expect([...hard.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it('handles an empty (fully transparent) source in every preset', () => {
    const empty: RgbaImage = { width: 8, height: 8, data: new Uint8ClampedArray(256) };
    for (const preset of PIXEL_PRESETS) {
      const { image, report } = filterImage(empty, { target: { w: 4, h: 4 }, preset });
      expect(image.data.every((v) => v === 0)).toBe(true);
      expect(report.opaquePixels).toBe(0);
    }
  });

  it('rejects bad input and settings that are not ported', () => {
    expect(() => filterImage(src, { target: { w: 0, h: 4 }, preset: 'sprite' })).toThrow(/target/);
    expect(() => filterImage(src, { target: { w: 1.5, h: 4 }, preset: 'sprite' })).toThrow(
      /target/,
    );
    expect(() => filterImage(src, { target: { w: 4, h: 2 }, preset: 'item' })).toThrow(/square/);
    expect(() =>
      filterImage(
        { ...src, data: new Uint8ClampedArray(3) },
        { target: { w: 1, h: 1 }, preset: 'none' },
      ),
    ).toThrow(/bytes/);
    expect(() =>
      filterImage(
        { width: 0, height: 1, data: new Uint8ClampedArray(0) },
        { target: { w: 1, h: 1 }, preset: 'none' },
      ),
    ).toThrow(/source size/);
    expect(() =>
      filterImage(src, { target: { w: 1, h: 1 }, preset: 'bogus' as PixelPreset }),
    ).toThrow(/preset/);
    const bad =
      (settings: unknown): (() => unknown) =>
      () =>
        filterImage(src, {
          target: { w: 2, h: 2 },
          preset: 'sprite',
          settings: settings as PixelSettings,
        });
    expect(bad({ dither: 'ordered' })).toThrow(/dither/);
    expect(bad({ before: { blur: 1 } })).toThrow(/before/);
    expect(bad({ outline: 'outer' })).toThrow(/outer/);
    expect(bad({ downscale: 'median' })).toThrow(/median/);
    expect(bad({ cleanup: { symmetry: true } })).toThrow(/symmetry/);
    expect(bad({ alpha: 'smooth' })).toThrow(/smooth/);
    expect(bad({ colors: { palette: ['red'] } })).toThrow(/#rrggbb/);
  });
});
