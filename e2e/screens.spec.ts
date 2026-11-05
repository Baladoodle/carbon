import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmd } from '@core/commands/registry';
import { stressWorld } from '../src/core/testing/stress';
import { writeWorldDir } from '../src/main/store/world-dir';
import { sampleWorld } from '../src/core/testing/sample';
import { withArt, withHollowsBiomes } from './art';
import { launchCarbon, SCREEN_SCALE, type CarbonApp } from './harness';

/**
 * The canonical screens in `docs/screens/` (run with UPDATE_SCREENS=1, which
 * also takes them at device scale factor 2 in the 1440×900 window): one per
 * view, the Bench collapsed and expanded, the palette, a spread mid-stream and
 * the 2,000-entity Column. The AI log's is ai.spec.ts's (the real gateway's
 * replay, with real usage and costs). The sample world, the fake AI, and a
 * little setup so each surface shows real content: formulas and a curve with
 * an intent, a spread on the field, decided entities chosen for an export, a
 * critique on the Bench.
 */

let carbon: CarbonApp;
const page = (): Page => carbon.page;
const body = () => page().locator('body');

test.beforeAll(async () => {
  carbon = await launchCarbon({ scale: SCREEN_SCALE });
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

test('screens of every view, the Bench and the palette', async () => {
  test.setTimeout(120_000);
  const docs = { docs: true };
  // Column, with an entity on the Bench and a critique in the margin.
  await carbon.gotoView('column', '1');
  await focus('Vent Glass Visor', 'vent-glass-visor');
  await body().press('?');
  await expect(
    page().locator('[data-testid="column-margin"] .column-note[data-source="ai"]').first(),
  ).toBeVisible();
  await settle();
  await carbon.screenshot('column', docs);

  // The Bench as it opens: filled and needed fields, the rest behind + Field.
  await focus('Spore Lantern', 'spore-lantern');
  await settle();
  await carbon.screenshot('bench', { ...docs, element: page().getByTestId('bench') });

  // Expanded: every field revealed, a suggestion waiting inline, an accepted
  // one with its ai marker.
  for (;;) {
    const add = page().getByTestId('bench-add-field');
    if ((await add.count()) === 0) break;
    await add.click();
    await page().getByRole('menuitem').first().click();
  }
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
  await settle();
  await carbon.screenshot('bench-expanded', { ...docs, element: page().getByTestId('bench') });
  await page().keyboard.press('Escape');
  await page().keyboard.press('Escape');

  // Climate's canonical screen is the images test's (its panels hold concept art).

  await carbon.gotoView('codex', '3');
  await body().press('/');
  await page().getByTestId('codex-filter').fill('lane:items');
  await page().getByTestId('codex-filter').press('Enter');
  await body().press('j');
  await settle();
  await carbon.screenshot('codex', docs);

  await carbon.gotoView('numbers', '4');
  await expect(page().getByTestId('numbers-curve').first()).toBeVisible();
  await settle();
  await carbon.screenshot('numbers', docs);

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
  await carbon.screenshot('spread', docs);

  await carbon.gotoView('taste', '6');
  await settle();
  await carbon.screenshot('taste', docs);

  await carbon.gotoView('export', '7');
  await page().getByTestId('export-kind-band').click();
  await page().getByTestId('export-draft').click();
  await expect(page().getByTestId('export-editor')).toBeVisible();
  await settle();
  await carbon.screenshot('export', docs);

  await carbon.gotoView('column', '1');
  await body().press('Control+k');
  await page().keyboard.type('glid');
  await expect(page().getByTestId('palette').locator('[data-highlighted]')).toBeVisible();
  await carbon.screenshot('palette', docs);
  await page().keyboard.press('Escape');
});

test('a spread mid-stream', async () => {
  const slow = await launchCarbon({ env: { CARBON_AI_DELAY_MS: '400' }, scale: SCREEN_SCALE });
  try {
    await slow.gotoView('spread', '5');
    await slow.page.locator('body').press('s');
    const spot = slow.page.getByRole('combobox', { name: 'Spot' });
    await spot.fill('Hollows · creatures');
    await spot.press('Enter');
    await slow.page.locator('body').press('Enter');
    await expect(slow.page.getByTestId('spread-progress')).toBeVisible();
    await expect
      .poll(() => slow.page.locator('[data-testid="spread-card"]').count())
      .toBeGreaterThan(4);
    await slow.page.mouse.move(2, 2);
    await slow.screenshot('spread-streaming', { docs: true });
    await slow.page.locator('body').press('Escape');
  } finally {
    await slow.close();
  }
});

test('the Column over 2,000 entities', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'carbon-screens-'));
  await writeWorldDir(tmp, stressWorld(2000));
  const big = await launchCarbon({ worldDir: tmp, scale: SCREEN_SCALE });
  try {
    await big.gotoView('column', '1');
    await expect(big.page.getByTestId('status-entities')).toHaveText('2000 entities');
    await big.page.mouse.move(2, 2);
    await big.page.waitForTimeout(300);
    await big.screenshot('column-stress', { docs: true });
  } finally {
    await big.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('images: Climate panels filled by concept art, the Bench strip, the confirm step, a batch', async () => {
  test.setTimeout(120_000);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'carbon-screens-art-'));
  const art = withArt(withHollowsBiomes(sampleWorld()), tmp);
  await writeWorldDir(tmp, art);
  const c = await launchCarbon({ worldDir: tmp, scale: SCREEN_SCALE });
  const p = c.page;
  const calm = async (): Promise<void> => {
    await p.mouse.move(2, 2);
    await expect(p.locator('.ui-toast')).toHaveCount(0, { timeout: 15000 });
    await expect(p.locator('.img-shimmer, [data-loading]')).toHaveCount(0);
  };
  try {
    // Climate: every Hollows biome filled by its concept, one selected.
    await c.gotoView('climate', '2');
    await p.getByRole('tab', { name: 'Hollows' }).click();
    const region = (id: string) => p.locator(`[data-testid="climate-region"][data-entity="${id}"]`);
    for (const id of ['glowmoss-caverns', 'ash-vents', 'mossed-hollows', 'painted-plains'])
      await expect(region(id).getByTestId('climate-art')).toHaveAttribute('data-loaded', '');
    await region('glowmoss-caverns').click();
    const plane = (await p.getByTestId('climate-plane').boundingBox())!;
    await p.mouse.move(plane.x + plane.width * 0.44, plane.y + plane.height * 0.86);
    await expect(p.locator('.ui-toast')).toHaveCount(0, { timeout: 15000 });
    await c.screenshot('climate', { docs: true });

    // The Bench's image strip: the concept, the icon at 1× and 4×, earlier versions.
    await p.locator('body').press('Control+k');
    await p.keyboard.type('Spore Lantern');
    await expect(p.getByTestId('palette').locator('[data-highlighted]')).toContainText(
      'Spore Lantern',
    );
    await p.keyboard.press('Enter');
    await expect(p.getByTestId('bench-entity')).toHaveAttribute('data-entity', 'spore-lantern');
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(p.getByTestId('bench-version')).toHaveCount(3);
    await calm();
    await c.screenshot('bench-images', { docs: true, element: p.getByTestId('bench') });

    // The confirm step: Claude's prompt, the model, low quality, the size, the cost.
    await p.locator('body').press('Control+g');
    await expect(p.getByTestId('image-prompt')).not.toHaveValue('');
    await expect(p.getByTestId('image-estimate')).toHaveText(/^\$/);
    await p.mouse.move(2, 2);
    await c.screenshot('images-confirm', { docs: true });
    await p.keyboard.press('Escape');

    // A batch from the Codex selection, with every prompt editable.
    await c.gotoView('codex', '3');
    await p.getByRole('tab', { name: /^Items/ }).click();
    await p.getByTestId('codex-scroll').focus();
    await p.locator('body').press('Control+a');
    await p.getByTestId('codex-bulk-icons').click();
    await expect(p.getByTestId('image-batch')).toHaveAttribute('data-phase', 'ready');
    await p.getByRole('combobox', { name: 'Existing' }).click();
    await p.getByRole('option', { name: 'Replace' }).click();
    await expect(p.getByTestId('image-batch-calls')).toHaveText('4 calls');
    await p.mouse.move(2, 2);
    await c.screenshot('images-batch', { docs: true });
    await p.keyboard.press('Escape');
  } finally {
    await c.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
