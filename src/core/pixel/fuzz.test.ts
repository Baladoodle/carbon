/**
 * Opt-in fuzz parity against the real Genforge (scripts/pixel-fuzz.py makes the
 * cases). Skipped unless PIXEL_FUZZ points at a generated directory.
 */
import { readFileSync } from 'node:fs';
import { env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { filterImage } from './filter';
import { decodePng } from './png';
import type { PixelPreset } from './types';

const DIR = env['PIXEL_FUZZ'];

describe.skipIf(!DIR)('fuzz parity with Genforge (PIXEL_FUZZ)', () => {
  it('matches every generated case exactly', () => {
    const cases = JSON.parse(readFileSync(`${DIR}/cases.json`, 'utf8')) as {
      src: string;
      preset: PixelPreset;
      w: number;
      h: number;
    }[];
    const bad: string[] = [];
    for (const c of cases) {
      const src = decodePng(readFileSync(`${DIR}/${c.src}.png`));
      const ref = decodePng(readFileSync(`${DIR}/${c.src}-${c.preset}.png`));
      const out = filterImage(src, { target: { w: c.w, h: c.h }, preset: c.preset }).image;
      let n = 0;
      for (let i = 0; i < out.data.length; i += 4) {
        if ([0, 1, 2, 3].some((k) => out.data[i + k] !== ref.data[i + k])) n++;
      }
      if (n) bad.push(`${c.src} ${c.preset} ${c.w}x${c.h}: ${n} px`);
    }
    expect(bad).toEqual([]);
  });
});
