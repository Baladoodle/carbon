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
  // Typed straight after n, before the new biome is on the Bench: no letter is lost.
  await press('n');
  await page().keyboard.type('Glowmoss Caverns');
  await press('Enter');
  await leaveField();
  await expect(bench().locator('.bench-title-input')).toHaveValue('Glowmoss Caverns');
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
  /** Relates the entity on the Bench through the picker. */
  const relate = async (type: string, target: string, id: string): Promise<void> => {
    const add = page().locator('[data-bench-field="relation"]');
    await add.getByRole('combobox', { name: 'Relation type' }).click();
    await page().getByRole('option', { name: type, exact: true }).click();
    const to = add.getByRole('combobox', { name: 'Relate to' });
    await to.click();
    await page().keyboard.type(target);
    await press('Enter');
    await expect(page().locator(`[data-rel="${type.replace(' ', '_')}:${id}"]`)).toBeVisible();
    await leaveField();
  };
  // Brine Strider (on the Bench) lives in Salt Flats and drops Salt Glass.
  await relate('lives in', 'Salt Flats', 'new-biome-2');
  await relate('drops', 'Salt Glass', 'new-material');
  // Salt Glass is found in Salt Flats.
  await open('Salt Glass');
  await relate('found in', 'Salt Flats', 'new-biome-2');

  // A structure from the Codex: n on its tab, the name typed inline; in Meadow Steps.
  await carbon.gotoView('codex', '3');
  await page()
    .getByRole('tab', { name: /Structures/ })
    .click();
  await press('n');
  const nameCell = page().locator('[data-entity="new-structure"] td[data-col="name"] input');
  await expect(nameCell).toBeFocused();
  await nameCell.fill('Salt Kiln');
  await nameCell.press('Enter');
  await expect(bench()).toHaveAttribute('data-entity', 'new-structure');
  await relate('in biome', 'Meadow Steps', 'new-biome');
  await shot('09-codex-structure');
  await expect(page().getByTestId('codex-filter')).toHaveAttribute(
    'placeholder',
    /^Filter: state:/,
  );
  // On the Column: the structure sits in Surface, placed through its biome.
  await carbon.gotoView('column', '1');
  await expect(
    page().locator(
      '[data-testid="column-svg"] [data-cell="new-band|structures"] [data-id="new-structure"]',
    ),
  ).toHaveCount(1);
  // 3. Progression: a capability, an item with a route, a feat that unlocks the capability.
  await clickCell('new-band-2', 'Capabilities');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-capability');
  await page().keyboard.type('Glide');
  await press('Enter');
  await leaveField();
  await setField('verb', 'glide');
  await clickCell('new-band-2', 'Items');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-item');
  await page().keyboard.type('Kite Cloak');
  await press('Enter');
  await leaveField();
  await shot('10-item');
  await field('subkind').getByRole('combobox').click();
  await page().getByRole('option', { name: 'accessory' }).click();
  await setField('identity', 'A cloak that catches updrafts.');
  await setField('change', 'You fall slowly while holding jump.');
  await setField('tradeoff', 'Heavy rain grounds you.');
  // Its route: one step that needs Glide.
  await bench().getByRole('button', { name: 'Field' }).click();
  await page().getByRole('menuitem', { name: 'Route' }).click();
  await field('route').locator('button.bench-add').click();
  const step = field('route').getByLabel('Step 1', { exact: true });
  await step.fill('Weave updraft silk at a Salt Kiln');
  await step.press('Enter');
  await field('route').getByRole('combobox', { name: 'What step 1 needs' }).click();
  await page().keyboard.type('Glide');
  await press('Enter');
  await leaveField();
  await expect(field('route').locator('[data-chip="new-capability"]')).toBeVisible();
  await expect
    .poll(() => read('entities/item/new-item.md'))
    .toMatch(/route:\s+- text: Weave updraft silk at a Salt Kiln\s+needs:\s+- new-capability/);
  await shot('11-item-route');
  // A feat in Low Sky that unlocks Glide.
  await clickCell('new-band-2', 'Feats');
  await press('n');
  await expect(bench()).toHaveAttribute('data-entity', 'new-feat');
  await page().keyboard.type('First Flight');
  await press('Enter');
  await leaveField();
  await relate('unlocks', 'Glide', 'new-capability');
  await shot('12-feat');
  // 4. Numbers: a variable, formulas, an attribute on items, a curve with an intent.
  await carbon.gotoView('numbers', '4');
  await shot('13-numbers-empty');
  await press('v');
  const varName = page().getByTestId('numbers-variables').getByRole('textbox', { name: 'Name' });
  await varName.fill('k');
  await varName.press('Enter');
  const varValue = page().getByRole('textbox', { name: 'Value of k' });
  await varValue.fill('100');
  await varValue.press('Enter');
  await expect(page().getByTestId('var-k')).toHaveText('100');
  const source = page().getByTestId('numbers-source');
  await source.click();
  await page().keyboard.type('taken(raw, def) = raw * k / (k + def)\nhit = taken(20, 4)\n');
  await page().keyboard.type('lift_at(b: band) = 2 * (b.tier + 1)\n');
  await expect(page().getByTestId('numbers-values').locator('li').nth(1)).toHaveText('19.2308');
  await expect.poll(() => read('numbers/formulas.carbon')).toContain('lift_at(b: band)');
  await source.blur();
  // An attribute on items: lift.
  await page().getByRole('combobox', { name: 'Kind' }).click();
  await page().getByRole('option', { name: 'Items' }).click();
  await body().press('a');
  const attrKey = page().getByRole('textbox', { name: 'New attribute key' });
  await attrKey.fill('lift');
  await attrKey.press('Enter');
  await expect(page().locator('[data-attr="lift"]')).toBeVisible();
  // A curve over the bands: lift_at(x), with items' lift as dots.
  await body().press('c');
  const curve = page().getByTestId('numbers-curve').first();
  const y = curve.getByRole('textbox', { name: 'Curve formula' });
  await y.fill('lift_at(x)');
  await y.press('Enter');
  await shot('14-numbers-curve');
  const dots = curve.getByRole('textbox', { name: 'Dots' });
  await dots.fill('items');
  await dots.press('Enter');
  const dotValue = curve.getByRole('textbox', { name: 'Dot value' });
  await dotValue.fill('.lift');
  await dotValue.press('Enter');
  // Kite Cloak's lift, on the Bench, becomes a dot on the curve.
  await open('Kite Cloak');
  const lift = field('attributes.lift').locator('input');
  await lift.fill('3');
  await lift.press('Enter');
  await leaveField();
  await expect(curve.locator('.plot-dot[data-entity="new-item"]')).toHaveCount(1);
  // The intent: a double-click on the plot puts down its first point, + adds the next.
  const plot = curve.getByTestId('curve-plot');
  const pb = (await plot.boundingBox())!;
  await page().mouse.dblclick(pb.x + pb.width * 0.5, pb.y + pb.height * 0.3);
  const handles = curve.getByTestId('intent-handle');
  await expect(handles).toHaveCount(1);
  await handles.first().focus();
  await press('+');
  await expect(handles).toHaveCount(2);
  await press('Shift+ArrowUp');
  await expect.poll(() => read('numbers/curves.json')).toContain('"intent"');
  await shot('15-numbers-intent');
  // 5. A spread from a Column cell: Low Sky's items. Triage with keeps and kills.
  await carbon.gotoView('column', '1');
  await clickCell('new-band-2', 'Items');
  const before = new Set(Object.keys((await world()).entities));
  await body().press('Space');
  await expect(page().getByTestId('view-spread')).toBeVisible();
  await expect(page().getByTestId('spread-spot')).toHaveText('Low Sky · items');
  await shot('16-spread-ready');
  await press('Enter');
  const openCards = page().locator(
    '[data-testid="spread-card"][data-state="open"]:not(.spread-card-out)',
  );
  await expect(openCards).toHaveCount(12);
  await expect(page().getByTestId('spread-progress')).toHaveCount(0);
  await shot('17-spread');
  await press('k');
  await expect(openCards).toHaveCount(11);
  for (const reason of ['1', '1', '2']) {
    await press('x');
    await expect(page().getByTestId('spread-kill-reasons')).toBeVisible();
    await press(reason);
  }
  await expect(openCards).toHaveCount(8);
  // u undoes the last kill; the candidate comes back.
  await press('u');
  await expect(openCards).toHaveCount(9);
  await press('x');
  await press('2');
  await expect(openCards).toHaveCount(8);
  const kept = Object.values((await world()).entities).filter((e) => !before.has(e.id));
  expect(kept).toHaveLength(1);
  expect(kept[0]?.kind).toBe('item');
  // Taste: the kills count against their reasons; Learn proposes patterns; promote one.
  await carbon.gotoView('taste', '6');
  await expect(page().getByTestId('taste-reason-count').first()).toHaveText('2');
  await page().getByTestId('taste-learn').click();
  const patterns = page().getByTestId('taste-pattern');
  await expect(patterns.first()).toBeVisible();
  await shot('18-taste');
  await patterns.first().getByTestId('taste-promote').click();
  await expect(page().getByTestId('taste-rule')).toHaveCount(1);
  expect((await world()).taste.patterns.some((p) => p.status === 'promoted')).toBe(true);
  // 6. The lifecycle: Kite Cloak from idea to shaped (the menu), then decided with a Why (d).
  // On the Column: in Taste, d is the view's own key (dismiss the pattern) and wins.
  await carbon.gotoView('column', '1');
  await open('Kite Cloak');
  await expect(bench()).toHaveAttribute('data-state', 'idea');
  await page().getByTestId('bench-menu').click();
  await page().getByRole('menuitem', { name: 'Mark shaped' }).click();
  await expect(bench()).toHaveAttribute('data-state', 'shaped');
  await press('d');
  await page().getByTestId('why-input').fill('Low Sky needs one way to stay up that costs you.');
  await press('Control+Enter');
  // Deciding needs a moment: the Bench says so under the field, and nothing changes.
  await expect(field('moment').locator('.ui-field-error')).toHaveText('Needed to be decided');
  await expect(bench()).toHaveAttribute('data-state', 'shaped');
  await shot('19-needs-moment');
  await setField('moment', 'The first gap you can’t jump.');
  // Filled, it no longer says it's needed.
  await expect(field('moment').locator('.ui-field-error')).toHaveCount(0);
  await press('d');
  await page().getByTestId('why-input').fill('Low Sky needs one way to stay up that costs you.');
  await press('Control+Enter');
  await expect(bench()).toHaveAttribute('data-state', 'decided');
  await expect
    .poll(() => read('entities/item/new-item.md'))
    .toContain('why: Low Sky needs one way to stay up that costs you.');
  // Undo takes it back to shaped; redo decides it again.
  await body().press('Control+z');
  await expect(bench()).toHaveAttribute('data-state', 'shaped');
  await body().press('Control+Shift+z');
  await expect(bench()).toHaveAttribute('data-state', 'decided');
  // Glide straight from idea to decided: d passes through shaped in one step.
  await open('Glide');
  await setField('identity', 'Hold jump to fall like a leaf.');
  await setField('gates', 'the gaps between Low Sky islands');
  await press('d');
  await page().getByTestId('why-input').fill('Kite Cloak is built on it.');
  await press('Control+Enter');
  await expect(bench()).toHaveAttribute('data-state', 'decided');
  await shot('20-decided');
  // 7. Export a spec: the decided entities of Low Sky, drafted, edited, written.
  await carbon.gotoView('export', '7');
  await shot('21-export-empty');
  await page().getByTestId('export-band-new-band-2').click();
  await expect(page().getByTestId('export-count')).toHaveText('2 entities');
  // The AI draft (the fake gateway's is a stub), then the deterministic template, which
  // is what a world without a key gets: fields, route, relations, why, formulas.
  await page().getByTestId('export-draft').click();
  const editor = page().getByTestId('export-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('data-ai', '');
  await body().press('Control+k');
  await page().keyboard.type('Use the spec template');
  await press('Enter');
  await expect(editor).not.toHaveAttribute('data-ai', '');
  await expect(editor).toHaveValue(/## Kite Cloak/);
  await expect(editor).toHaveValue(/## Glide/);
  await editor.press('Control+End');
  await editor.pressSequentially('\nBuild Glide first.');
  await shot('22-export-draft');
  await editor.press('Control+s');
  await expect(editor).toHaveCount(0);
  const exportsDir = path.join(carbon.worldDir, 'exports');
  const specs = (): string[] =>
    existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.md')) : [];
  await expect.poll(specs).toHaveLength(1);
  const spec = readFileSync(path.join(exportsDir, specs()[0]!), 'utf8');
  expect(spec).toContain('Build Glide first.');
  expect(spec).toContain('Weave updraft silk at a Salt Kiln');
  expect((await byName('Kite Cloak'))?.state).toBe('exported');
  expect((await byName('Glide'))?.state).toBe('exported');

  // 8. Undo and redo the export: the file and the marking go and come back together.
  await body().press('Control+z');
  await expect.poll(specs).toEqual([]);
  await expect.poll(async () => (await byName('Kite Cloak'))?.state).toBe('decided');
  await body().press('Control+Shift+z');
  await expect.poll(specs).toHaveLength(1);
  await expect.poll(async () => (await byName('Kite Cloak'))?.state).toBe('exported');
  // Editing an exported entity flags it as changed since the export.
  await open('Kite Cloak');
  await setField('tradeoff', 'Heavy rain or strong wind grounds you.');
  await shot('23-after-export');
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
