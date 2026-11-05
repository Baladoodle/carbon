/**
 * Parity against the real Genforge (docs/IMAGES.md §2).
 *
 * References live in fixtures/pixel/reference/<preset>/<w>x<h>/<source>.png and are
 * produced only by `node scripts/pixel-references.mjs --genforge <path>`. Every
 * reference file found is compared against the port with the tolerance below.
 *
 * Tolerances start at EXACT for every preset. Loosening one requires measuring
 * the real difference and justifying it in docs/build-notes/pixel.md; `item` at
 * 16×16 and 32×32 must stay exact.
 *
 * Status: no references are committed yet (Genforge's repository was not readable
 * from this environment), so this suite currently has nothing to compare and is
 * reported as skipped rather than passing. It is NOT evidence of parity.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterImage } from './filter';
import { decodePng } from './png';
import type { PixelPreset } from './types';

const ROOT = resolve(import.meta.dirname, '../../../fixtures/pixel');

interface Tolerance {
  /** Pixels allowed to differ in any channel. */
  pixels: number;
  /** Largest allowed per-channel difference. */
  delta: number;
}
const EXACT: Tolerance = { pixels: 0, delta: 0 };
const TOLERANCE: Record<PixelPreset, Tolerance> = {
  item: EXACT,
  sprite: EXACT,
  texture: EXACT,
  none: EXACT,
};
const MUST_BE_EXACT = new Set(['item/16x16', 'item/32x32']);

const cases: { preset: PixelPreset; size: string; w: number; h: number; file: string }[] = [];
const refRoot = join(ROOT, 'reference');
if (existsSync(refRoot)) {
  for (const preset of readdirSync(refRoot) as PixelPreset[]) {
    if (!(preset in TOLERANCE)) continue;
    for (const size of readdirSync(join(refRoot, preset))) {
      const [w, h] = size.split('x').map(Number);
      for (const file of readdirSync(join(refRoot, preset, size)).filter((f) =>
        f.endsWith('.png'),
      )) {
        cases.push({ preset, size, w: w!, h: h!, file });
      }
    }
  }
}

describe('tolerance policy', () => {
  it('keeps item at 16×16 and 32×32 exact', () => {
    for (const key of MUST_BE_EXACT) {
      const preset = key.split('/')[0] as PixelPreset;
      expect(TOLERANCE[preset]).toEqual(EXACT);
    }
  });
});

describe.skipIf(cases.length === 0)('parity with Genforge', () => {
  it.each(cases)('$preset $size $file', ({ preset, size, w, h, file }) => {
    const src = decodePng(readFileSync(join(ROOT, 'sources', file)));
    const ref = decodePng(readFileSync(join(refRoot, preset, size, file)));
    const out = filterImage(src, { target: { w, h }, preset }).image;
    expect([out.width, out.height]).toEqual([ref.width, ref.height]);
    let pixels = 0;
    let delta = 0;
    for (let p = 0; p < out.data.length; p += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(out.data[p + c]! - ref.data[p + c]!));
      if (d > 0) pixels++;
      delta = Math.max(delta, d);
    }
    const tol = MUST_BE_EXACT.has(`${preset}/${size}`) ? EXACT : TOLERANCE[preset];
    expect({ pixels, delta }).toSatisfy(
      (r: Tolerance) => r.pixels <= tol.pixels && r.delta <= tol.delta,
    );
  });
});
