import { expect, test } from '@playwright/test';
import { launchCarbon, type CarbonApp } from './harness';

let carbon: CarbonApp;
test.beforeAll(async () => {
  carbon = await launchCarbon();
});
test.afterAll(async () => {
  await carbon.close();
});

test('column renders', async () => {
  await carbon.gotoView('column', '1');
  await expect(carbon.page.getByTestId('column')).toBeVisible();
  await carbon.page.waitForTimeout(500);
  await carbon.page.screenshot({ path: '/tmp/claude-0/shots/col1.png' });
});
