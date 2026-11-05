import { expect, test } from '@playwright/test';
import { launchCarbon } from './harness';

/**
 * The harness fails a test when the main process had an unhandled rejection
 * or an uncaught exception (src/main/unhandled.ts). This checks the hook
 * itself: a rejection nobody handles, raised in the real main process, makes
 * `close()` fail with it.
 */
test('@smoke an unhandled rejection in main fails the test that caused it', async () => {
  const carbon = await launchCarbon();
  await carbon.app.evaluate(() => {
    void Promise.reject(new Error('nobody waited for this'));
  });
  // Let the rejection be reported (it is, after the current microtasks).
  await carbon.app.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  await expect(carbon.close()).rejects.toThrow(/unhandledRejection.*nobody waited for this/);
});
