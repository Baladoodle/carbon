import { expect, test, type Page } from '@playwright/test';
import { cmd } from '@core/commands/registry';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * One up-to-date screenshot per view, plus the Bench and the palette:
 * `docs/screens/<view>.png` (run with UPDATE_SCREENS=1). The AI log's is
 * ai.spec.ts's. The sample world,
 * the fake AI, and a little setup so each surface shows real content:
 * formulas and a curve with an intent, a spread on the field, decided
 * entities chosen for an export, a critique on the Bench.
 */

let carbon: CarbonApp;
const page = (): Page => carbon.page;
const body = () => page().locator('body');

test.beforeAll(async () => {
  carbon = await launchCarbon();
  const r = await carbon.dispatch(
    cmd('numbers.setFormulas', {
      source: `# Damage taken through armor
taken(raw, def) = raw * k / (k + def)
hit = taken(20, 4)
armor = items where subkind == "armor"
band_defense(b: band) = sum(armor where band == b, .defense)
budget(b: band) = 4 * (b.tier + 3)
soak(a: item) = a.defense * 3
`,
    }),
    cmd('entity.create', {
      kind: 'item',
      name: 'Moss Weave',
      identity: 'Armor that grows back.',
      fields: { subkind: 'armor' },
      attributes: { defense: 2 },
      relations: [{ type: 'in_band', target: 'groundline' }],
    }),
    cmd('entity.create', {
      kind: 'item',
      name: 'Reef Plate',
      identity: 'Coral that hardens in the wind.',
      fields: { subkind: 'armor' },
      attributes: { defense: 22 },
      relations: [{ type: 'in_band', target: 'low-sky' }],
    }),
    cmd('numbers.putCurve', {
      curve: {
        id: 'defense-budget',
        y: 'budget(x)',
        over: { axis: 'band' },
        dots: { query: 'armor', value: '.defense' },
        intent: [
          { x: 'undercroft', y: 3 },
          { x: 'hollows', y: 6 },
          { x: 'groundline', y: 10 },
          { x: 'low-sky', y: 15 },
          { x: 'high-drift', y: 21 },
        ],
      },
    }),
  );
  expect(r.ok).toBe(true);
});
test.afterAll(async () => {
  await carbon.close();
});

/** Puts an entity on the Bench through the palette. */
async function focus(name: string, id: string): Promise<void> {
  await body().press('Control+k');
  await page().keyboard.type(name);
  await expect(page().getByTestId('palette').locator('[data-highlighted]')).toContainText(name);
  await page().keyboard.press('Enter');
  await expect(page().getByTestId('bench-entity')).toHaveAttribute('data-entity', id);
  await page().evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** No pointer hover, no toasts: a calm frame. */
async function settle(): Promise<void> {
  await page().mouse.move(2, 2);
  await expect(page().locator('.ui-toast')).toHaveCount(0, { timeout: 15000 });
}

test('screens of every view, the Bench, the palette and the AI log', async () => {
  // Column, with an entity on the Bench and a critique in the margin.
  await carbon.gotoView('column', '1');
  await focus('Vent Glass Visor', 'vent-glass-visor');
  await body().press('?');
  await expect(
    page().locator('[data-testid="column-margin"] .column-note[data-source="ai"]').first(),
  ).toBeVisible();
  await settle();
  await carbon.screenshot('column');

  // The Bench on its own: a suggestion waiting inline in a field, the ai markers
  // of accepted fields, live consequences and the notes.
  await focus('Spore Lantern', 'spore-lantern');
  const tradeoff = page().locator('[data-bench-field="tradeoff"] input');
  await tradeoff.click();
  await tradeoff.fill('');
  await tradeoff.press('Enter');
  await page().keyboard.press('Tab');
  await expect(page().locator('[data-bench-field="tradeoff"] .ui-suggest-ghost')).toBeVisible();
  await page().keyboard.press('Tab');
  await expect(page().getByTestId('ai-marker-tradeoff')).toBeVisible();
  const moment = page().locator('[data-bench-field="moment"] input');
  await moment.click();
  await page().keyboard.press('Tab');
  await expect(page().locator('[data-bench-field="moment"] .ui-suggest-ghost')).toBeVisible();
  await page().mouse.move(2, 2);
  await expect(page().locator('.ui-toast')).toHaveCount(0, { timeout: 15000 });
  await carbon.screenshot('bench', { element: page().getByTestId('bench') });
  await page().keyboard.press('Escape');
  await page().keyboard.press('Escape');

  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Hollows' }).click();
  await settle();
  await carbon.screenshot('climate');

  await carbon.gotoView('codex', '3');
  await body().press('/');
  await page().getByTestId('codex-filter').fill('lane:items');
  await page().getByTestId('codex-filter').press('Enter');
  await body().press('j');
  await settle();
  await carbon.screenshot('codex');

  await carbon.gotoView('numbers', '4');
  await expect(page().getByTestId('numbers-curve').first()).toBeVisible();
  await settle();
  await carbon.screenshot('numbers');

  await carbon.gotoView('spread', '5');
  await body().press('s');
  const spot = page().getByRole('combobox', { name: 'Spot' });
  await spot.fill('Low Sky · items');
  await spot.press('Enter');
  await body().press('Enter');
  await expect(
    page().locator('[data-testid="spread-card"][data-state="open"]:not(.spread-card-out)'),
  ).toHaveCount(12);
  await expect(page().getByTestId('spread-progress')).toHaveCount(0);
  await body().press('k');
  await body().press('x');
  await page().keyboard.press('3');
  await settle();
  await carbon.screenshot('spread');

  await carbon.gotoView('taste', '6');
  await settle();
  await carbon.screenshot('taste');

  await carbon.gotoView('export', '7');
  await page().getByTestId('export-kind-band').click();
  await page().getByTestId('export-draft').click();
  await expect(page().getByTestId('export-editor')).toBeVisible();
  await settle();
  await carbon.screenshot('export');

  await carbon.gotoView('column', '1');
  await body().press('Control+k');
  await page().keyboard.type('glid');
  await expect(page().getByTestId('palette').locator('[data-highlighted]')).toBeVisible();
  await carbon.screenshot('palette');
  await page().keyboard.press('Escape');

  await body().press('Control+l');
  await expect(page().getByTestId('ai-log')).toBeVisible();
  await settle();
  // docs/screens/ai-log.png is ai.spec.ts's, on the real gateway (replay) with real
  // usage and costs; on the fake AI every number here is zero.
  await carbon.screenshot('screens-ai-log', { docs: false });
  await page().keyboard.press('Escape');
});
