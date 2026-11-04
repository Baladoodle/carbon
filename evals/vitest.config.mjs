// The eval runner's own Vitest config: `npm run eval` and `npm run smoke:ai`
// run `src/main/ai/evals/*.eval.ts` with it (never part of `npm test`).
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = resolve(import.meta.dirname, '..');

export default defineConfig({
  root,
  resolve: {
    alias: {
      '@core': resolve(root, 'src/core'),
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main'),
      '@renderer': resolve(root, 'src/renderer'),
    },
  },
  test: {
    include: ['src/main/ai/evals/*.eval.ts'],
    environment: 'node',
    testTimeout: 900_000,
    reporters: ['default'],
  },
});
