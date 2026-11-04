import { expect, test } from '@playwright/test';
import { launchCarbon, type CarbonApp } from './harness';

let carbon: CarbonApp;
test.beforeAll(async () => {
  carbon = await launchCarbon();
});
test.afterAll(async () => {
  await carbon.close();
});

test('@smoke the UI kit renders and its controls work from the keyboard', async () => {
  const page = carbon.page;
  await page.locator('body').press('Control+k');
  await page.keyboard.type('UI kit');
  await page.keyboard.press('Enter');
  const kit = page.getByTestId('ui-kit');
  await expect(kit).toBeVisible();

  // The AI suggestion shows inline in --ai after the typed text.
  await expect(kit.locator('.ui-suggest-ghost').first()).toHaveText('ss Lung');
  await carbon.screenshot('foundation-ui-kit');

  // Combobox: type to filter, enter to choose.
  const combo = kit.getByRole('combobox', { name: 'Made from' });
  await combo.click();
  await combo.fill('lumen');
  await expect(page.getByRole('option', { name: /Lumen Spore/ })).toBeVisible();
  await combo.press('Enter');
  await expect(combo).toHaveValue('Lumen Spore');

  // Dialog opens with focus inside and closes with escape.
  await kit.getByRole('button', { name: 'Dialog' }).click();
  await expect(page.getByRole('dialog', { name: 'Why is it decided?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Why' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Why is it decided?' })).toHaveCount(0);

  // Toasts appear and carry their tone.
  await kit.getByRole('button', { name: 'Error toast' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Could not save' })).toBeVisible();

  // Icon buttons have tooltips with their key.
  await kit.getByRole('button', { name: 'New entity' }).hover();
  await expect(page.locator('.ui-tooltip').filter({ hasText: 'New entity' })).toContainText('n');
});
