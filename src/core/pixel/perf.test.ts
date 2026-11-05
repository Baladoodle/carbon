import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterImage } from './filter';
import { decodePng } from './png';
import { PIXEL_PRESETS } from './types';
import type { RgbaImage } from './types';

/**
 * Budget: one 1024×1024 source to 16×16 in under 300 ms (docs/build-notes/pixel.md).
 * Two sources: a dense 800-px disc (the worst case for item's hairline morphology)
 * and the bow fixture (a typical transparent icon source).
 */
/** Coverage instrumentation slows these ~200 ms pipelines several-fold; the budget is for plain Node. */
const instrumented = Boolean(
  (
    (globalThis as Record<string, unknown>)['__vitest_worker__'] as
      { config?: { coverage?: { enabled?: boolean } } } | undefined
  )?.config?.coverage?.enabled,
);

describe.skipIf(instrumented)('performance', () => {
  const N = 1024;
  const data = new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const x = i % N;
    const y = (i / N) | 0;
    const inside = (x - 512) ** 2 + (y - 512) ** 2 < 400 ** 2;
    data.set([x & 255, y & 255, (x ^ y) & 255, inside ? 255 : 0], i * 4);
  }
  const disc: RgbaImage = { width: N, height: N, data };
  const bow = decodePng(
    readFileSync(resolve(import.meta.dirname, '../../../fixtures/pixel/sources/bow-1024.png')),
  );

  for (const [name, src] of [
    ['disc', disc],
    ['bow', bow],
  ] as const) {
    it.each(PIXEL_PRESETS)(`%s: ${name} 1024² → 16² under 300 ms`, (preset) => {
      filterImage(src, { target: { w: 16, h: 16 }, preset }); // warm-up (JIT)
      const runs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        filterImage(src, { target: { w: 16, h: 16 }, preset });
        runs.push(performance.now() - t);
      }
      expect(Math.min(...runs)).toBeLessThan(300);
    });
  }
});
