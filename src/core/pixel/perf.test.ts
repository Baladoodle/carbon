import { describe, expect, it } from 'vitest';
import { filterImage } from './filter';
import { PIXEL_PRESETS } from './types';

/** Budget: one 1024×1024 source to 16×16 in under 300 ms (docs/build-notes/pixel.md). */
describe('performance', () => {
  const N = 1024;
  const data = new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const x = i % N;
    const y = (i / N) | 0;
    const inside = (x - 512) ** 2 + (y - 512) ** 2 < 400 ** 2;
    data.set([x & 255, y & 255, (x ^ y) & 255, inside ? 255 : 0], i * 4);
  }
  const src = { width: N, height: N, data };

  it.each(PIXEL_PRESETS)('%s: 1024² → 16² under 300 ms', (preset) => {
    filterImage(src, { target: { w: 16, h: 16 }, preset }); // warm-up (JIT)
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      filterImage(src, { target: { w: 16, h: 16 }, preset });
      runs.push(performance.now() - t);
    }
    expect(Math.min(...runs)).toBeLessThan(300);
  });
});
