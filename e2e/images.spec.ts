import { expect, test, type Page } from '@playwright/test';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * images-ui: every image flow in the real app, on the fake provider
 * (CARBON_IMAGES=fake; nothing calls OpenAI). Deliberate only: nothing is
 * sent before the confirm step's enter.
 */
let carbon: CarbonApp;
const page = (): Page => carbon.page;
const body = () => page().locator('body');
const world = async () => (await carbon.invoke('world:snapshot', null)).world;
const region = (id: string) =>
  page().locator(`[data-testid="climate-region"][data-entity="${id}"]`);
const confirm = () => page().getByTestId('image-confirm');
const imageLog = async () => carbon.invoke('images:log', {});

test.beforeAll(async () => {
  carbon = await launchCarbon();
});
test.afterAll(async () => {
  await carbon.close();
});

test('climate: a panel menu generates a concept that fills the panel; esc cancels with nothing sent', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Hollows' }).click();
  await expect(region('glowmoss-caverns')).toBeVisible();

  // The panel's menu: Generate concept opens the confirm step; esc cancels it.
  await region('glowmoss-caverns').click({ button: 'right' });
  await page().getByRole('menuitem', { name: 'Generate concept' }).click();
  await expect(confirm()).toBeVisible();
  await expect(page().getByTestId('image-prompt')).not.toHaveValue('');
  await expect(page().getByTestId('image-estimate')).toHaveText(/^\$/);
  await page().keyboard.press('Escape');
  await expect(confirm()).toHaveCount(0);
  expect(await imageLog()).toEqual([]);

  // Again, then enter: the image lands in the panel.
  await region('glowmoss-caverns').click({ button: 'right' });
  await page().getByRole('menuitem', { name: 'Generate concept' }).click();
  await expect(page().getByTestId('image-prompt')).not.toHaveValue('');
  await page().getByTestId('image-prompt').press('Enter');
  await expect(confirm()).toHaveCount(0);
  await expect(region('glowmoss-caverns').getByTestId('climate-art')).toHaveAttribute(
    'data-loaded',
    '',
  );
  await expect(region('glowmoss-caverns')).toHaveClass(/climate-region-art/);
  const w = await world();
  const im = w.images?.['glowmoss-caverns'];
  expect(im?.concept).toBeDefined();
  // Low quality and Images 2.6 flare, by default.
  expect(await imageLog()).toMatchObject([
    { kind: 'concept', quality: 'low', model: 'gpt-image-2.6-flare', outcome: 'ok' },
  ]);
  await carbon.screenshot('images-climate');
});

test('bench: the biome in focus shows its concept; a click enlarges it, esc closes', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Hollows' }).click();
  await region('glowmoss-caverns').click();
  const bench = page().getByTestId('bench-entity');
  await expect(bench).toHaveAttribute('data-entity', 'glowmoss-caverns');
  await expect(bench.getByTestId('bench-concept').locator('img')).toBeVisible();
  // Biomes take no icon: the strip offers concept actions only.
  await expect(bench.getByTestId('bench-image-icon')).toHaveCount(0);
  await bench.getByTestId('bench-concept').click();
  await expect(page().getByTestId('image-lightbox')).toBeVisible();
  await carbon.screenshot('images-lightbox');
  await page().keyboard.press('Escape');
  await expect(page().getByTestId('image-lightbox')).toHaveCount(0);
});

const chip = (id: string) => page().locator(`[data-testid="column-svg"] [data-id="${id}"]`).first();

test('keys: ctrl+shift+g on the selected item asks first; the prompt, model and quality are editable; the icon shows on its chip, pixelated', async () => {
  await carbon.gotoView('column', '1');
  await chip('spore-lantern').click();
  await expect(page().getByTestId('bench-entity')).toHaveAttribute('data-entity', 'spore-lantern');
  const before = (await imageLog()).length;

  await body().press('Control+Shift+G');
  await expect(confirm()).toHaveAttribute('data-kind', 'icon');
  await expect(confirm()).toHaveAttribute('data-entity', 'spore-lantern');
  const prompt = page().getByTestId('image-prompt');
  await expect(prompt).not.toHaveValue('');
  await prompt.fill('A lantern of glowing spores in a glass bulb, held by its ring.');
  await page().getByRole('combobox', { name: 'Model' }).click();
  await page().getByRole('option', { name: 'Images 2.6 sunburst' }).click();
  await page().getByRole('combobox', { name: 'Quality' }).click();
  await page().getByRole('option', { name: 'medium' }).click();
  // The size of an icon is fixed (generated square, filtered to 16×16).
  await expect(page().getByRole('combobox', { name: 'Size' })).toBeDisabled();
  await carbon.screenshot('images-confirm-icon');
  // Nothing has been sent yet.
  expect((await imageLog()).length).toBe(before);
  await prompt.press('Enter');
  await expect(confirm()).toHaveCount(0);

  await expect(chip('spore-lantern').locator('[data-icon]')).toHaveCount(1);
  const rendering = await chip('spore-lantern')
    .locator('[data-icon]')
    .evaluate((el) => getComputedStyle(el).imageRendering);
  expect(rendering).toBe('pixelated');
  const log = await imageLog();
  expect(log.length).toBe(before + 1);
  expect(log.at(-1)).toMatchObject({
    entity: 'spore-lantern',
    kind: 'icon',
    model: 'gpt-image-2.6-sunburst',
    quality: 'medium',
  });
  const w = await world();
  const icon = w.images?.['spore-lantern']?.all.find(
    (m) => m.id === w.images?.['spore-lantern']?.icon,
  );
  expect(icon?.origin).toMatchObject({ prompt: expect.stringContaining('glowing spores') });

  // The Bench shows it at 1× and 4×, pixelated.
  const bench = page().getByTestId('bench-entity');
  await expect(bench.getByTestId('bench-icon-4x')).toBeVisible();
  await expect(bench.getByTestId('bench-icon-1x')).toBeVisible();
  expect(
    await bench.getByTestId('bench-icon-4x').evaluate((el) => getComputedStyle(el).imageRendering),
  ).toBe('pixelated');
});

test('bench: Concept, then Icon from concept (free), Choose an earlier version and Remove, each undone', async () => {
  await carbon.gotoView('column', '1');
  await chip('spore-lantern').click();
  const bench = page().getByTestId('bench-entity');
  await expect(bench).toHaveAttribute('data-entity', 'spore-lantern');

  // Concept from the strip's button, with the default model and quality.
  await bench.getByTestId('bench-image-concept').click();
  await expect(page().getByTestId('image-prompt')).not.toHaveValue('');
  await carbon.screenshot('images-confirm', { docs: false });
  await page().getByTestId('image-confirm-run').click();
  await expect(bench.getByTestId('bench-concept').locator('img')).toBeVisible();

  // Icon from concept: the item filter, no paid call.
  const paid = (await imageLog()).length;
  const firstIcon = (await world()).images?.['spore-lantern']?.icon;
  await bench.getByTestId('bench-image-from-concept').click();
  await expect
    .poll(async () => (await world()).images?.['spore-lantern']?.icon)
    .not.toBe(firstIcon);
  const w1 = await world();
  const filtered = w1.images?.['spore-lantern']?.all.find(
    (m) => m.id === w1.images?.['spore-lantern']?.icon,
  );
  expect(filtered?.origin.by).toBe('filter');
  expect((await imageLog()).length).toBe(paid);
  await carbon.screenshot('bench-images-raw');

  // Choose the earlier icon from its thumbnail; undo puts the filtered one back.
  const earlier = bench.locator(`[data-testid="bench-version"][data-image="${firstIcon}"]`);
  await expect(earlier).toBeVisible();
  await earlier.click();
  await expect.poll(async () => (await world()).images?.['spore-lantern']?.icon).toBe(firstIcon);
  await body().press('Control+z');
  await expect.poll(async () => (await world()).images?.['spore-lantern']?.icon).toBe(filtered?.id);

  // Remove the concept from the Bench menu; undo brings it back.
  const concept = (await world()).images?.['spore-lantern']?.concept;
  await page().getByTestId('bench-menu').click();
  await page().getByRole('menuitem', { name: 'Remove concept' }).click();
  await expect.poll(async () => (await world()).images?.['spore-lantern']?.concept).toBeUndefined();
  await expect(bench.getByTestId('bench-concept')).toHaveCount(0);
  await body().press('Control+z');
  await expect.poll(async () => (await world()).images?.['spore-lantern']?.concept).toBe(concept);
  await expect(bench.getByTestId('bench-concept').locator('img')).toBeVisible();
});

test('codex: the image column, the row menu, and a batch from the bulk bar (skip existing, then replace)', async () => {
  await carbon.gotoView('codex', '3');
  await page()
    .getByRole('tab', { name: /^Items/ })
    .click();
  const row = (id: string) => page().locator(`[data-testid="codex-table"] tr[data-entity="${id}"]`);
  await expect(row('spore-lantern').getByTestId('codex-image')).toBeVisible();
  await expect(row('cloud-anklet').getByTestId('codex-image')).toHaveCount(0);

  // The row menu has the image actions.
  await row('cloud-anklet').locator('td').nth(3).click({ button: 'right' });
  await expect(page().getByRole('menuitem', { name: 'Generate icon' })).toBeVisible();
  await page().keyboard.press('Escape');

  // Select every item, then Icons… in the bulk bar.
  await page().getByTestId('codex-scroll').focus();
  await body().press('Control+a');
  await expect(page().getByTestId('codex-selection')).toContainText('4');
  await page().getByTestId('codex-bulk-icons').click();
  const batch = page().getByTestId('image-batch');
  await expect(batch).toHaveAttribute('data-phase', 'ready');
  await expect(page().getByTestId('image-batch-row')).toHaveCount(4);
  // Spore Lantern has an icon: skipped unless replace.
  await expect(
    page().locator('[data-testid="image-batch-row"][data-entity="spore-lantern"]'),
  ).toHaveAttribute('data-skip', '');
  await expect(page().getByTestId('image-batch-calls')).toHaveText('1 call · 3 icons');
  await page()
    .locator('[data-testid="image-batch-row"][data-entity="cloud-anklet"] textarea')
    .fill('An anklet of braided cloud, light as breath.');
  await page().getByRole('combobox', { name: 'Existing' }).click();
  await page().getByRole('option', { name: 'Replace' }).click();
  await expect(page().getByTestId('image-batch-calls')).toHaveText('1 call · 4 icons');
  await page().getByRole('combobox', { name: 'Existing' }).click();
  await page().getByRole('option', { name: 'Skip' }).click();
  await expect(page().getByTestId('image-batch-calls')).toHaveText('1 call · 3 icons');
  await carbon.screenshot('images-batch-ready');
  const before = (await imageLog()).length;
  // Icons batch as one sheet (IMAGES.md §2a): one paid call, then a review.
  await page().getByTestId('image-batch-run').click();
  await expect(batch).toHaveAttribute('data-phase', 'review');
  expect((await imageLog()).length).toBe(before + 1);
  const cells = page().getByTestId('image-cell');
  await expect(cells).toHaveCount(3);
  await expect(page().getByTestId('image-batch-progress')).toContainText('1 of 1 sheet');
  await expect(page().getByTestId('image-batch-progress')).toContainText(/\$0\.0*[1-9]/);
  await carbon.screenshot('images-sheet-review');
  // Reject the Cloud Anklet's cell, and regenerate it as a smaller sheet.
  const anklet = page().locator('[data-testid="image-cell"][data-entity="cloud-anklet"]');
  if ((await anklet.getAttribute('aria-pressed')) === 'true') await anklet.click();
  await expect(anklet).toHaveAttribute('aria-pressed', 'false');
  await expect(page().getByTestId('image-batch-accept')).toHaveText('Accept 2');
  await page().getByTestId('image-batch-regenerate').click();
  await expect(batch).toHaveAttribute('data-phase', 'review');
  expect((await imageLog()).length).toBe(before + 2);
  await expect(page().getByTestId('image-sheet')).toHaveCount(2);
  await expect(cells).toHaveCount(3);
  await expect(anklet).toHaveAttribute('aria-pressed', 'true');
  await page().getByTestId('image-batch-accept').click();
  await expect(batch).toHaveAttribute('data-phase', 'done');
  await expect(page().locator('[data-testid="image-batch-row"][data-result="ok"]')).toHaveCount(3);
  const w = await world();
  const im = w.images?.['cloud-anklet'];
  const made = im?.all.find((m) => m.id === im.icon);
  expect(made?.origin.by).toBe('sheet');
  // The sheet it came from is kept (re-cropping is free), and it carries the edited line.
  const sheetId = made?.origin.by === 'sheet' ? made.origin.sheet : '';
  const sheet = Object.values(w.images ?? {})
    .flatMap((x) => x.all)
    .find((m) => m.id === sheetId);
  expect(sheet?.kind).toBe('sheet');
  expect(JSON.stringify(sheet?.origin)).toContain('braided cloud');
  await page().getByTestId('image-batch-close').click();
  await expect(batch).toHaveCount(0);
  await expect(row('cloud-anklet').getByTestId('codex-image')).toBeVisible();
  await body().press('Escape');
});

test('budget: when the image budget is reached, the confirm step says so and enter sends nothing; raising it resumes', async () => {
  await carbon.dispatch({
    type: 'settings.set',
    payload: { key: 'images', value: { budget: { sessionUsd: 0, monthUsd: 10 } } },
  } as never);
  await expect(page().getByTestId('status-images')).toHaveAttribute('data-state', 'paused');
  const before = (await imageLog()).length;
  await carbon.gotoView('column', '1');
  await chip('vent-glass-visor').click();
  await body().press('Control+g');
  await expect(page().getByTestId('image-confirm-blocked')).toContainText('paused');
  await expect(page().getByTestId('image-prompt')).not.toHaveValue('');
  await expect(page().getByTestId('image-confirm-run')).toBeDisabled();
  await page().getByTestId('image-prompt').press('Enter');
  await expect(confirm()).toBeVisible();
  await page().keyboard.press('Escape');
  expect((await imageLog()).length).toBe(before);

  // Raise it from the status line.
  await page().getByTestId('status-images').click();
  await page().getByTestId('image-budget-session').fill('5');
  await page().getByTestId('image-budget-save').click();
  await expect(page().getByTestId('status-images')).not.toHaveAttribute('data-state', 'paused');
});

test('taste: the art direction and a per-kind note, each one undo step', async () => {
  await carbon.gotoView('taste', '6');
  const dir = page().getByTestId('taste-art-direction');
  await dir.fill('painterly, muted earth tones, soft rim light, readable silhouettes');
  await dir.press('Control+Enter');
  await expect
    .poll(async () => (await world()).settings.art?.direction)
    .toBe('painterly, muted earth tones, soft rim light, readable silhouettes');
  await page().getByTestId('taste-art-add').click();
  await page().getByRole('menuitem', { name: 'Biome' }).click();
  const note = page().locator('[data-testid="taste-art-kind"][data-kind="biome"] input');
  await expect(note).toBeFocused();
  await note.fill('wide establishing shots');
  await note.press('Enter');
  await expect
    .poll(async () => (await world()).settings.art?.kinds.biome)
    .toBe('wide establishing shots');
  await carbon.screenshot('images-taste');
  await body().press('Control+z');
  await expect.poll(async () => (await world()).settings.art?.kinds.biome).toBeUndefined();
  await expect(page().locator('[data-testid="taste-art-kind"][data-kind="biome"]')).toHaveCount(0);
  await expect(dir).toHaveValue(
    'painterly, muted earth tones, soft rim light, readable silhouettes',
  );
});

test('ai log and export: image calls with thumbnails; the spec preview shows the chosen entities’ images', async () => {
  await body().press('Control+l');
  await expect(page().getByTestId('ai-log')).toBeVisible();
  await expect(
    page().locator('[data-testid="ai-log-row"][data-kind="image"]').first(),
  ).toBeVisible();
  await expect(page().getByTestId('ai-log-thumb').first()).toBeVisible();
  await expect(page().getByTestId('ai-log-totals')).toContainText('OpenAI');
  await body().press('Escape');
  await expect(page().getByTestId('ai-log')).toHaveCount(0);

  await carbon.gotoView('export', '7');
  await page().locator('[data-testid="export-list"] [data-entity="cinder-sting"]').click();
  await expect(page().getByTestId('export-images').getByTestId('export-icon')).toBeVisible();
});

test('batch: progress, then cancel the rest; finished items keep their image, the rest are not sent', async () => {
  const slow = await launchCarbon({ env: { CARBON_IMAGES_DELAY_MS: '700' } });
  try {
    const p = slow.page;
    await slow.gotoView('codex', '3');
    await p.getByRole('tab', { name: /^Biomes/ }).click();
    await p.getByTestId('codex-scroll').focus();
    await p.locator('body').press('Control+a');
    // The key reaches the rows the filter shows: a batch of concepts.
    await p.locator('body').press('Control+g');
    const batch = p.getByTestId('image-batch');
    await expect(batch).toHaveAttribute('data-phase', 'ready');
    await expect(p.getByTestId('image-batch-calls')).toHaveText('4 calls');
    await p.getByTestId('image-batch-prompt').first().press('Control+Enter');
    await expect(batch).toHaveAttribute('data-phase', 'running');
    await expect(p.getByTestId('image-batch-progress')).toBeVisible();
    await expect(p.locator('[data-testid="image-batch-row"][data-result="ok"]')).toHaveCount(2, {
      timeout: 10_000,
    });
    await p.getByTestId('image-batch-cancel').click();
    await expect(batch).toHaveAttribute('data-phase', 'done');
    const made = await p.locator('[data-testid="image-batch-row"][data-result="ok"]').count();
    expect(made).toBeLessThan(4);
    const w = (await slow.invoke('world:snapshot', null)).world;
    expect(Object.values(w.images ?? {}).filter((x) => x.concept).length).toBe(made);
    const log = await slow.invoke('images:log', {});
    expect(log.filter((l) => l.outcome === 'ok').length).toBe(made);
    await p.getByTestId('image-batch-close').click();
    await expect(batch).toHaveCount(0);
  } finally {
    await slow.close();
  }
});
