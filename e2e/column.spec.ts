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
  const { page } = carbon;
  await carbon.gotoView('column', '1');
  await expect(page.getByTestId('column')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/claude-0/shots/col1.png' });
  await page.locator('[data-id="spore-lantern"]').click();
  await expect(page.getByTestId('bench-entity')).toHaveAttribute('data-entity', 'spore-lantern');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/claude-0/shots/col2.png' });
  await page.locator('body').press('k');
  await page.locator('body').press('k');
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/claude-0/shots/col3.png' });
});
