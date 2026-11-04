import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { cmd } from '@core/commands/registry';
import { launchCarbon, type CarbonApp } from './harness';

/** W2 (world): the Codex and Climate views. */

let carbon: CarbonApp;
const page = () => carbon.page;
const body = () => page().locator('body');

test.beforeAll(async () => {
  carbon = await launchCarbon();
});
test.afterAll(async () => {
  await carbon.close();
});

const rowIds = async (): Promise<string[]> =>
  page()
    .locator('[data-testid="codex-table"] tbody tr[data-entity]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-entity') ?? ''));

const filter = async (q: string): Promise<void> => {
  await body().press('/');
  await page().getByTestId('codex-filter').fill(q);
  await page().getByTestId('codex-filter').press('Enter');
};

test('@smoke codex filters with the query language, shows inline errors and follows lane to its tab', async () => {
  await carbon.gotoView('codex', '3');
  await expect(page().getByTestId('codex-table')).toBeVisible();
  await filter('state:decided band:"Low Sky" lane:capabilities');
  await expect(page().getByRole('tab', { selected: true })).toContainText('Capabilities');
  expect(await rowIds()).toEqual(['glide']);
  await filter('stat:idea');
  await expect(page().getByTestId('codex-filter-errors')).toContainText(
    'unknown filter "stat"; did you mean state?',
  );
  await filter('');
  await expect(page().getByTestId('codex-filter-errors')).toHaveCount(0);
});

test('codex edits a cell inline through a command, and undo reverts it', async () => {
  await carbon.gotoView('codex', '3');
  await filter('kind:band');
  await page().locator('[data-entity="hollows"] td[data-col="f:danger"]').dblclick();
  const editor = page().locator('[data-entity="hollows"] td[data-col="f:danger"] input');
  await expect(editor).toHaveValue('3..6');
  await editor.fill('4..8');
  await editor.press('Enter');
  await expect(page().locator('[data-entity="hollows"] td[data-col="f:danger"]')).toHaveText('4–8');
  await expect
    .poll(() => readFileSync(path.join(carbon.worldDir, 'entities/band/hollows.md'), 'utf8'))
    .toContain('max: 8');
  await body().press('Control+z');
  await expect(page().locator('[data-entity="hollows"] td[data-col="f:danger"]')).toHaveText('3–6');
  // An invalid value is refused with the reason, and nothing changes.
  await page().locator('[data-entity="hollows"] td[data-col="f:danger"]').dblclick();
  await editor.fill('8..2');
  await editor.press('Enter');
  await expect(editor).toHaveAttribute('aria-invalid', 'true');
  await editor.press('Escape');
  await expect(page().locator('[data-entity="hollows"] td[data-col="f:danger"]')).toHaveText('3–6');
  await filter('');
});

test('codex multi-selects and changes state in bulk in one undo step', async () => {
  await carbon.gotoView('codex', '3');
  await filter('kind:material state:idea');
  expect(await rowIds()).toEqual(['sky-coral', 'vent-glass']);
  await body().press('Control+a');
  await expect(page().getByTestId('codex-selection')).toContainText('2');
  await body().press('s');
  await expect(page().getByTestId('codex-state-dialog')).toBeVisible();
  await body().press('g');
  await body().press('2'); // seen it
  await expect(page().getByTestId('codex-state-dialog')).toHaveCount(0);
  await filter('kind:material state:graveyard');
  expect(await rowIds()).toEqual(['sky-coral', 'vent-glass']);
  await body().press('Control+z');
  await filter('kind:material state:graveyard');
  await expect(page().getByTestId('codex-empty')).toHaveText('Nothing matches.');
  await body().press('Escape');
  await filter('');
});

test('codex space aims a spread at the selection', async () => {
  await carbon.gotoView('codex', '3');
  await filter('lane:items');
  await page().locator('[data-entity="cloud-anklet"] td[data-col="name"]').click();
  await page()
    .locator('[data-entity="spore-lantern"] td[data-col="name"]')
    .click({
      modifiers: ['Control'],
    });
  await page()
    .locator('[data-entity="cloud-anklet"] td[data-col="name"]')
    .click({
      modifiers: ['Control'],
    });
  await body().press(' ');
  await page().waitForSelector('[data-testid="view-spread"]');
  // The spot is in the shared UI state, for the Spread view to read.
  await carbon.gotoView('codex', '3');
  await body().press('Escape');
  await filter('');
});

test('codex screenshots', async () => {
  await carbon.dispatch(cmd('entity.update', { id: 'glide', set: { tags: ['sky'] } }));
  await carbon.gotoView('codex', '3');
  await filter('lane:items');
  await page().locator('[data-entity="vent-glass-visor"] td[data-col="name"]').click();
  await carbon.screenshot('world-codex');
  await filter('kind:creature menace:>lots');
  await carbon.screenshot('world-codex-error');
  await filter('');
});
