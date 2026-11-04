import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cmd } from '@core/commands/registry';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * The Numbers view (W3): formulas with live values and inline errors,
 * variables edited inline, attribute definitions, and curves with dots and a
 * draggable intent curve. Screenshots go to docs/screens/numbers-*.png.
 */
const FORMULAS = `# Damage taken through armor
taken(raw, def) = raw * k / (k + def)
hit = taken(20, 4)
armor = items where subkind == "armor"
band_defense(b: band) = sum(armor where band == b, .defense)
budget(b: band) = 4 * (b.tier + 3)
hp = base_health * 1.5
`;

let carbon: CarbonApp;
const page = (): Page => carbon.page;

async function setUpSample(): Promise<void> {
  const r = await carbon.dispatch(
    cmd('numbers.setFormulas', { source: FORMULAS }),
    cmd('relation.add', { from: 'vent-glass-visor', type: 'in_band', to: 'hollows' }),
    cmd('entity.create', {
      kind: 'item',
      name: 'Moss Weave',
      fields: { subkind: 'armor' },
      attributes: { defense: 2 },
      relations: [{ type: 'in_band', target: 'groundline' }],
    }),
    cmd('entity.create', {
      kind: 'item',
      name: 'Reef Plate',
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
    cmd('numbers.putCurve', {
      curve: {
        id: 'mitigation',
        y: 'taken(20, x)',
        over: { axis: 'attribute', kind: 'item', key: 'defense', min: 0, max: 100 },
        dots: { query: 'armor' },
      },
    }),
  );
  expect(r.ok).toBe(true);
}

test.beforeAll(async () => {
  carbon = await launchCarbon();
  await setUpSample();
});
test.afterAll(async () => {
  await carbon.close();
});

/** Screenshots without the transient toasts of earlier steps. */
async function shot(name: string): Promise<void> {
  await expect(page().locator('.ui-toast')).toHaveCount(0, { timeout: 8000 });
  await carbon.screenshot(name);
}

const source = () => page().getByTestId('numbers-source');
const gutter = (line: number) =>
  page()
    .getByTestId('numbers-values')
    .locator('li')
    .nth(line - 1);

test('@smoke shows formulas with live values, variables and curves', async () => {
  await carbon.gotoView('numbers', '4');
  await expect(source()).toHaveValue(FORMULAS);
  await expect(gutter(2)).toHaveText('(number, number) → number');
  await expect(gutter(3)).toHaveText('19.2308');
  await expect(gutter(7)).toHaveText('150');
  await expect(page().getByTestId('var-k')).toHaveText('100');
  await expect(page().getByTestId('numbers-curve')).toHaveCount(2);
  await expect(page().locator('[data-curve="defense-budget"] .plot-dot')).toHaveCount(3);
  await expect(
    page().locator('[data-curve="defense-budget"] [data-testid="intent-handle"]'),
  ).toHaveCount(5);
  await shot('numbers-view');
});

test('@smoke marks errors inline as you type and commits after a pause', async () => {
  await carbon.gotoView('numbers', '4');
  await source().click();
  await page().keyboard.press('Control+End');
  await page().keyboard.type('bad = hit + nope\n');
  await expect(page().getByTestId('numbers-marks').locator('mark')).toHaveText(['nope']);
  await expect(gutter(8)).toHaveText(/Unknown name nope/);
  await page().keyboard.press('ArrowUp');
  await expect(page().getByTestId('numbers-problem')).toContainText('Unknown name nope');
  await shot('numbers-error');
  // Fix it; the value appears and the file is written.
  await source().fill(`${FORMULAS}bad = hit + hp\n`);
  await expect(gutter(8)).toHaveText('169.231');
  const file = path.join(carbon.worldDir, 'numbers/formulas.carbon');
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('bad = hit + hp');
  await source().blur();
});

test('edits a variable inline, and every value follows; undo restores it', async () => {
  await carbon.gotoView('numbers', '4');
  await page().getByTestId('var-k').click();
  const input = page().getByRole('textbox', { name: 'Value of k' });
  await input.fill('300');
  await input.press('Enter');
  await expect(page().getByTestId('var-k')).toHaveText('300');
  await expect(gutter(3)).toHaveText('19.7368');
  await page().locator('body').press('Control+z');
  await expect(page().getByTestId('var-k')).toHaveText('100');
  await expect(gutter(3)).toHaveText('19.2308');
});

test('renames a variable and its references', async () => {
  await carbon.gotoView('numbers', '4');
  await page().locator('[data-var="base_health"] .numbers-var-name').click();
  const input = page().getByRole('textbox', { name: 'Name' });
  await input.fill('health');
  await input.press('Enter');
  await expect(page().getByTestId('var-health')).toHaveText('100');
  await expect(source()).toHaveValue(/hp = health \* 1\.5/);
  await page().locator('body').press('Control+z');
  await expect(source()).toHaveValue(/hp = base_health \* 1\.5/);
});

test('defines an attribute on a kind', async () => {
  await carbon.gotoView('numbers', '4');
  await page().getByRole('combobox', { name: 'Kind' }).click();
  await page().getByRole('option', { name: 'Creatures' }).click();
  await page().locator('body').press('a');
  const key = page().getByRole('textbox', { name: 'New attribute key' });
  await key.fill('health');
  await key.press('Enter');
  await expect(page().locator('[data-attr="health"]')).toBeVisible();
  await page().getByRole('button', { name: 'health default' }).click();
  const def = page().getByRole('textbox', { name: 'health default' });
  await def.fill('40');
  await def.press('Enter');
  await expect(page().getByRole('button', { name: 'health default' })).toHaveText('40');
  const schema = JSON.parse(readFileSync(path.join(carbon.worldDir, 'schema.json'), 'utf8')) as {
    kinds: { creature?: { attributes?: unknown[] } };
  };
  expect(schema.kinds.creature?.attributes).toEqual([{ key: 'health', default: 40 }]);
  await shot('numbers-attributes');
});

test('drags an intent point and nudges one with the keyboard; both persist', async () => {
  await carbon.gotoView('numbers', '4');
  const card = page().locator('[data-curve="defense-budget"]');
  const handle = card.getByTestId('intent-handle').nth(1);
  const box = await handle.boundingBox();
  if (!box) throw new Error('no handle');
  await page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page().mouse.down();
  await page().mouse.move(box.x + box.width / 2, box.y - 40, { steps: 5 });
  await page().mouse.up();
  const file = path.join(carbon.worldDir, 'numbers/curves.json');
  const intentAt = (band: string): number | undefined =>
    (
      JSON.parse(readFileSync(file, 'utf8')) as {
        id: string;
        intent?: { x: string; y: number }[];
      }[]
    )
      .find((c) => c.id === 'defense-budget')
      ?.intent?.find((p) => p.x === band)?.y;
  await expect.poll(() => intentAt('hollows')).toBeGreaterThan(6);
  const before = intentAt('groundline') ?? 0;
  await card.getByTestId('intent-handle').nth(2).focus();
  await page().keyboard.press('Shift+ArrowUp');
  await expect.poll(() => intentAt('groundline')).toBeGreaterThan(before);
  // The dot off its intent is ringed.
  await expect(card.locator('.plot-dot[data-off]').first()).toBeVisible();
  await card.locator('.plot-dot[data-entity="reef-plate"]').hover();
  await expect(page().locator('.numbers-plot-tip')).toContainText('Reef Plate');
  await shot('numbers-curves');
});

test('adds a curve with c, edits its formula, and removes it', async () => {
  await carbon.gotoView('numbers', '4');
  await page().locator('body').press('c');
  await expect(page().getByTestId('numbers-curve')).toHaveCount(3);
  const y = page()
    .getByTestId('numbers-curve')
    .nth(2)
    .getByRole('textbox', { name: 'Curve formula' });
  await y.fill('nope + 1');
  await y.press('Enter');
  await expect(
    page().getByTestId('numbers-curve').nth(2).locator('.numbers-curve-error'),
  ).toContainText('nope');
  await y.fill('budget(x) * 2');
  await y.press('Enter');
  await expect(
    page().getByTestId('numbers-curve').nth(2).locator('.numbers-curve-error'),
  ).toHaveCount(0);
  await page()
    .getByTestId('numbers-curve')
    .nth(2)
    .getByRole('button', { name: 'Remove curve' })
    .click();
  await expect(page().getByTestId('numbers-curve')).toHaveCount(2);
});
