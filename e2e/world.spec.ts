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

const region = (id: string) =>
  page().locator(`[data-testid="climate-region"][data-entity="${id}"]`);
const climateOf = (id: string): string =>
  readFileSync(path.join(carbon.worldDir, `entities/biome/${id}.md`), 'utf8');

test('@smoke climate shows a band, switches with [ and ], and flags overlaps', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Hollows' }).click();
  await expect(region('glowmoss-caverns')).toBeVisible();
  await expect(region('ash-vents')).toBeVisible();
  await expect(region('glowmoss-caverns')).toContainText('Lumen Spore');
  await expect(page().getByTestId('climate-overlap')).toHaveCount(0);
  await body().press(']');
  await expect(page().getByRole('tab', { selected: true })).toHaveText('Undercroft');
  await body().press('[');
  await expect(page().getByRole('tab', { selected: true })).toHaveText('Hollows');
  // Move Ash Vents onto Glowmoss Caverns: the shared climate shows.
  await carbon.dispatch(
    cmd('entity.setField', {
      id: 'ash-vents',
      field: 'climate',
      value: { temperature: { min: 0.4, max: 0.7 }, moisture: { min: 0.5, max: 0.8 } },
    }),
  );
  await expect(page().getByTestId('climate-overlap')).toHaveCount(1);
  await expect(region('ash-vents')).toHaveClass(/climate-region-overlap/);
  await body().press('Control+z');
  await expect(page().getByTestId('climate-overlap')).toHaveCount(0);
});

test('climate drags a biome to move and resize it, as one undo step each', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Hollows' }).click();
  const plane = await page().getByTestId('climate-plane').boundingBox();
  if (!plane) throw new Error('no plane');
  const box = await region('ash-vents').boundingBox();
  if (!box) throw new Error('no region');
  // Move 10% colder.
  await page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page().mouse.down();
  await page().mouse.move(box.x + box.width / 2 - plane.width * 0.1, box.y + box.height / 2, {
    steps: 4,
  });
  await page().mouse.up();
  await expect.poll(() => climateOf('ash-vents')).toMatch(/min: 0\.65[\s\S]*max: 0\.9/);
  // Resize from the wet edge: 10% wetter.
  const after = await region('ash-vents').boundingBox();
  if (!after) throw new Error('no region');
  await page().mouse.move(after.x + after.width / 2, after.y + 1);
  await page().mouse.down();
  await page().mouse.move(after.x + after.width / 2, after.y + 1 - plane.height * 0.1, {
    steps: 4,
  });
  await page().mouse.up();
  await expect.poll(() => climateOf('ash-vents')).toMatch(/moisture:\s+min: 0\s+max: 0\.35/);
  await body().press('Control+z');
  await body().press('Control+z');
  await expect.poll(() => climateOf('ash-vents')).toMatch(/min: 0\.75\s+max: 1/);
});

test('climate keys: select, nudge, new biome, and space aims a spread at the region', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Groundline' }).click();
  await body().press('j');
  await expect(region('meadow-steps')).toHaveClass(/climate-region-selected/);
  await expect(page().getByTestId('bench-entity')).toHaveAttribute('data-entity', 'meadow-steps');
  await body().press('ArrowRight');
  await expect.poll(() => climateOf('meadow-steps')).toMatch(/min: 0\.45\s+max: 0\.75/);
  await body().press('Control+z');
  await body().press('n');
  await expect(page().locator('[data-testid="climate-region"]')).toHaveCount(2);
  await expect(page().getByTestId('bench-entity')).toHaveAttribute('data-entity', 'new-biome');
  await body().press('Control+z');
  await expect(page().locator('[data-testid="climate-region"]')).toHaveCount(1);
  await body().press(' ');
  await page().waitForSelector('[data-testid="view-spread"]');
});

test('climate screenshots', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Hollows' }).click();
  await carbon.dispatch(
    cmd('entity.create', {
      kind: 'biome',
      name: 'Dripstone Halls',
      fields: {
        band: 'hollows',
        climate: { temperature: { min: 0.45, max: 0.7 }, moisture: { min: 0.45, max: 0.75 } },
        mood: 'patient',
      },
    }),
  );
  await region('glowmoss-caverns').click();
  await carbon.screenshot('world-climate');
  await body().press('Control+z');
});
