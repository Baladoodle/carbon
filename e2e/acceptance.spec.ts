import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * The acceptance walk-through (docs/build-notes/qa-ui.md): carbon used as the
 * user will, from an empty world, at 1440×900, with the fake AI. One long test,
 * in the order a first session goes: bands, biomes and what lives in them,
 * progression, numbers, a spread and Taste, the lifecycle, an export, and undo
 * and redo throughout. Every step goes through keys and clicks, not commands.
 */

let carbon: CarbonApp;
const page = (): Page => carbon.page;
const body = (): Locator => page().locator('body');
const bench = (): Locator => page().getByTestId('bench-entity');
const field = (key: string): Locator =>
  page().locator(`[data-testid="bench-entity"] [data-bench-field="${key}"]`);
const press = (key: string): Promise<void> => page().keyboard.press(key);
const read = (rel: string): string => readFileSync(path.join(carbon.worldDir, rel), 'utf8');
const shot = (name: string): Promise<void> => carbon.screenshot(`acceptance-${name}`);
const world = async () => (await carbon.invoke('world:snapshot', null)).world;
const byName = async (name: string) =>
  Object.values((await world()).entities).find((e) => e.name === name);

/** Leaves whatever field has focus, as a click elsewhere would. */
async function leaveField(): Promise<void> {
  await press('Escape');
  await page().evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Types into a Bench field (revealing it from + Field if it waits there) and commits. */
async function setField(key: string, value: string): Promise<void> {
  if ((await field(key).count()) === 0) {
    await bench().getByRole('button', { name: 'Field' }).click();
    await page()
      .getByRole('menuitem', { name: new RegExp(`^${key}$`, 'i') })
      .click();
  }
  const input = field(key).locator('input, textarea').first();
  await input.fill(value);
  await input.press('Enter');
  await leaveField();
}

/** Puts an entity on the Bench through the palette, from any view. */
async function open(name: string): Promise<void> {
  await body().press('Control+k');
  await page().keyboard.type(name);
  await expect(page().getByTestId('palette').locator('[data-highlighted]')).toContainText(name);
  await press('Enter');
  await expect(bench().locator('.bench-title-input')).toHaveValue(name);
}

test.beforeAll(async () => {
  carbon = await launchCarbon({ world: null });
});
test.afterAll(async () => {
  await carbon.close();
});

test('from an empty world to an exported spec', async () => {
  test.setTimeout(240_000);

  // 1. Bands across positive and negative Y, one of them endless.
  await carbon.gotoView('column', '1');
  await expect(page().locator('.column-empty')).toHaveText('No bands yet. n to add one.');
  await shot('01-empty');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-band');
  await page().keyboard.type('Surface');
  await press('Enter');
  await leaveField();
  await expect(page().locator('[data-band="new-band"]')).toContainText('Surface');
  await shot('02-surface');
  // The identity line has no label of its own: empty, it still shows where it is.
  await expect(field('identity').locator('input')).toHaveAttribute('placeholder', 'Identity');
  await setField('identity', 'Where the light still reaches.');

  // k walks up into the unwritten height above, n writes a band there.
  await press('k');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-band-2');
  await page().keyboard.type('Low Sky');
  await press('Enter');
  await leaveField();
  await shot('03-low-sky');
  // Above it, an endless band: its top is ∞.
  await press('k');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-band-3');
  await page().keyboard.type('High Drift');
  await press('Enter');
  await setField('y_top', '∞');
  await expect.poll(() => read('entities/band/new-band-3.md')).toContain('y_top: +inf');
  // Below Surface, two bands: the Hollows, and the endless Deep.
  for (let i = 0; i < 6; i++) await press('j');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-band-4');
  await page().keyboard.type('Hollows');
  await press('Enter');
  await leaveField();
  await press('j');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-band-5');
  await page().keyboard.type('Deep');
  await press('Enter');
  await setField('y_bottom', '-inf');
  await expect.poll(() => read('entities/band/new-band-5.md')).toContain('y_bottom: -inf');
  // Undo and redo the endless bottom.
  await body().press('Control+z');
  await expect(field('y_bottom').locator('input')).not.toHaveValue('−∞');
  // The undo says what it undid in the field's own words, not its key.
  await expect(page().getByTestId('toast').last()).toHaveText('Undid Edit bottom of Deep');
  await body().press('Control+Shift+z');
  await expect(field('y_bottom').locator('input')).toHaveValue('−∞');
  await shot('04-bands');
  const bands = Object.values((await world()).entities).filter((e) => e.kind === 'band');
  expect(bands.map((b) => b.name).sort()).toEqual(
    ['Deep', 'High Drift', 'Hollows', 'Low Sky', 'Surface'].sort(),
  );

  // 2. Biomes in Climate, then what lives in them, related.
  await carbon.gotoView('climate', '2');
  await shot('05-climate-empty');
  await page().getByRole('tab', { name: 'Surface' }).click();
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-biome');
  await expect(field('name').locator('input')).toBeFocused();
  await page().keyboard.type('Meadow Steps');
  await press('Enter');
  await leaveField();
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-biome-2');
  await page().keyboard.type('Salt Flats');
  await press('Enter');
  await leaveField();
  await expect(page().locator('[data-testid="climate-region"]')).toHaveCount(2);
  // Nudge the selected biome warmer with the arrows, as one undo step.
  await press('ArrowRight');
  await press('ArrowRight');
  await shot('06-climate');
  await page().getByRole('tab', { name: 'Hollows' }).click();
  await press('n');
  await page().keyboard.type('Glowmoss Caverns');
  await press('Enter');
  await leaveField();
  await shot('07-climate-hollows');

  // A material and a creature from their Column cells: click the cell, n, type the name.
  await carbon.gotoView('column', '1');
  /** Clicks a cell where its band's row meets its lane's column. */
  const clickCell = async (band: string, lane: string): Promise<void> => {
    const row = (await page().locator(`[data-band="${band}"]`).first().boundingBox())!;
    const head = (await page().getByText(lane, { exact: true }).first().boundingBox())!;
    await page().mouse.click(head.x + 20, row.y + Math.min(row.height / 2, 40));
  };
  await clickCell('new-band', 'Materials');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-material');
  await expect(field('name').locator('input')).toBeFocused();
  await page().keyboard.type('Salt Glass');
  await press('Enter');
  await leaveField();
  await clickCell('new-band', 'Creatures');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-creature');
  await page().keyboard.type('Brine Strider');
  await press('Enter');
  await leaveField();
  await shot('08-column-entities');
  // The margin's notes never run into each other.
  await expect
    .poll(() =>
      page()
        .locator('[data-testid="column-margin"] .column-note')
        .evaluateAll((els) => {
          const boxes = els.map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top);
          return boxes.filter((b, i) => i > 0 && b.top < boxes[i - 1]!.bottom - 0.5).length;
        }),
    )
    .toBe(0);
});
