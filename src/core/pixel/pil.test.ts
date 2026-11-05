/**
 * pil.ts against Pillow 12.3 itself: fixtures/pixel/pillow/ holds random images
 * and Pillow's outputs (scripts/pixel-pillow.py). Every byte must match.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from './png';
import { gaussianBlur, premultiply, resize, unpremultiply } from './pil';
import type { Raster } from './pil';

const DIR = resolve(import.meta.dirname, '../../../fixtures/pixel/pillow');
const load = (name: string, c: 1 | 4): Raster => {
  const im = decodePng(readFileSync(`${DIR}/${name}.png`));
  const data = new Uint8Array(im.width * im.height * c);
  for (let i = 0; i < im.width * im.height; i++)
    for (let k = 0; k < c; k++) data[i * c + k] = im.data[i * 4 + k]!;
  return { w: im.width, h: im.height, c, data };
};
const { cases } = JSON.parse(readFileSync(`${DIR}/cases.json`, 'utf8')) as {
  cases: { i: number; tw: number; th: number }[];
};

describe('Pillow emulation', () => {
  it.each(cases)(
    'case $i: resize (LANCZOS, BOX, NEAREST) and GaussianBlur match Pillow',
    ({ i, tw, th }) => {
      const rgba = load(`src${i}`, 4);
      const L = load(`src${i}`, 1);
      const ours: Record<string, Raster> = {
        lanczosL: resize(L, tw, th, 'lanczos'),
        boxRGBA: resize(rgba, tw, th, 'box'),
        nearestRGBA: resize(rgba, tw * 2, th * 3, 'nearest'),
        blur04: gaussianBlur(L, 0.4),
        blur25: gaussianBlur(L, 2.5),
      };
      for (const [k, r] of Object.entries(ours)) {
        const ref = load(`${k}${i}`, r.c);
        expect([k, r.w, r.h]).toEqual([k, ref.w, ref.h]);
        expect(Buffer.from(r.data).equals(Buffer.from(ref.data)), k).toBe(true);
      }
    },
  );

  it('same-size resize and zero blur are copies', () => {
    const L = load('src0', 1);
    expect(resize(L, L.w, L.h, 'lanczos').data).toEqual(L.data);
    expect(gaussianBlur(L, 0).data).toEqual(L.data);
    expect(() => gaussianBlur(load('src0', 4), 1)).toThrow(/L rasters/);
  });

  it('premultiply follows MULDIV255 and unpremultiply its inverse rule', () => {
    const px: Raster = {
      w: 3,
      h: 1,
      c: 4,
      data: Uint8Array.from([200, 100, 50, 128, 9, 9, 9, 0, 1, 2, 3, 255]),
    };
    const pre = premultiply(px);
    expect([...pre.data]).toEqual([100, 50, 25, 128, 0, 0, 0, 0, 1, 2, 3, 255]);
    expect([...unpremultiply(pre).data]).toEqual([199, 99, 49, 128, 0, 0, 0, 0, 1, 2, 3, 255]);
  });
});
