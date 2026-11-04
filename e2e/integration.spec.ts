import { expect, test, type ConsoleMessage } from '@playwright/test';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * Cross-package flows on the sample world with the fake AI: the views built
 * in parallel (W1–W6), working as one app.
 */

const VIEWS = [
  ['column', '1'],
  ['climate', '2'],
  ['codex', '3'],
  ['numbers', '4'],
  ['spread', '5'],
  ['taste', '6'],
  ['export', '7'],
] as const;

test.describe('keys', () => {
  let carbon: CarbonApp;
  const duplicates: string[] = [];
  test.beforeAll(async () => {
    carbon = await launchCarbon();
    carbon.page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error' && m.text().includes('duplicate key')) duplicates.push(m.text());
    });
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('@smoke every rail key opens its view, and no layer binds a key twice', async () => {
    const { page } = carbon;
    // Visit every view with an entity on the Bench, then the overlays.
    await page.locator('body').press('Control+k');
    await page.keyboard.type('Glide');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('bench-entity')).toHaveAttribute('data-entity', 'glide');
    for (const [id, key] of VIEWS) {
      await page.locator('body').press(key);
      await expect(page.getByTestId(`view-${id}`)).toBeVisible();
      await expect(page.getByTestId(`rail-${id}`)).toHaveAttribute('aria-current', 'page');
    }
    await page.locator('body').press('Control+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('body').press('Control+l');
    await expect(page.getByTestId('ai-log')).toBeVisible();
    await page.keyboard.press('Escape');
    // Labels that follow state (the undo label) re-register layers: still no duplicates.
    await page.locator('body').press('1');
    await page.getByTestId('bench-entity').getByLabel('Name').fill('Glide II');
    await page.getByTestId('bench-entity').getByLabel('Name').press('Enter');
    await page.locator('body').press('Control+z');
    await expect(page.getByTestId('bench-entity').getByLabel('Name')).toHaveValue('Glide');
    await page.keyboard.press('Escape'); // leave the field
    await expect(page.getByTestId('bench-entity').getByLabel('Name')).not.toBeFocused();
    expect(duplicates).toEqual([]);
  });

  test('a view’s key beats the Bench’s while you’re in the view (Codex d over several rows)', async () => {
    const { page } = carbon;
    await carbon.gotoView('codex', '3');
    await page.locator('body').press('/');
    await page.getByTestId('codex-filter').fill('kind:material state:idea');
    await page.getByTestId('codex-filter').press('Enter');
    // Moving the cursor puts each row on the Bench (which re-registers its keys).
    await page.locator('body').press('j');
    await page.locator('body').press('k');
    await page.locator('body').press('Control+a');
    await expect(page.getByTestId('codex-selection')).toContainText('2');
    // d is the Codex's bulk decide (both rows), not the Bench's decide.
    await page.locator('body').press('d');
    await expect(page.getByTestId('codex-state-dialog')).toBeVisible();
    await expect(page.getByTestId('why-input')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('codex-state-dialog')).toHaveCount(0);
  });
});
