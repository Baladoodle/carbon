import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built Electron app (`npm run build` first).
// Run through `npm run test:e2e`, which wraps this in `xvfb-run -a` when needed.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
});
