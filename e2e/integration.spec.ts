import { expect, test, type ConsoleMessage, type Locator, type Page } from '@playwright/test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cmd } from '@core/commands/registry';
import { entityFromMarkdown, entityToMarkdown } from '@core/files/entity-file';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * Cross-package flows on the sample world with the fake AI: the views built
 * in parallel (W1–W6), working as one app.
 */

const chip = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="column-svg"] [data-id="${id}"]`).first();
const bench = (page: Page): Locator => page.getByTestId('bench-entity');
const field = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="bench-entity"] [data-bench-field="${key}"]`);
const read = (c: CarbonApp, rel: string): string =>
  readFileSync(path.join(c.worldDir, rel), 'utf8');
const body = (page: Page): Locator => page.locator('body');

async function world(c: CarbonApp) {
  return (await c.invoke('world:snapshot', null)).world;
}

/** Puts an entity on the Bench through the palette, from any view. */
async function open(page: Page, name: string, id: string): Promise<void> {
  await body(page).press('Control+k');
  await page.keyboard.type(name);
  await expect(page.getByTestId('palette').locator('[data-highlighted]')).toContainText(name);
  await page.keyboard.press('Enter');
  await expect(bench(page)).toHaveAttribute('data-entity', id);
}

/** Leaves whatever field has focus. */
async function leaveField(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

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

test.describe('building the world across views', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon();
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('a band in the Column, a biome in Climate, a material in the Codex; related, placed on the Column', async () => {
    const { page } = carbon;
    // Column (W1): raise High Drift's bottom on the Bench, which opens an unwritten gap…
    await carbon.gotoView('column', '1');
    await open(page, 'High Drift', 'high-drift');
    const bottom = field(page, 'y_bottom').locator('input');
    await bottom.fill('1000');
    await bottom.press('Enter');
    await leaveField(page);
    const gap = page.locator('[data-testid="column-svg"] [data-row="gap:0"]');
    await expect(gap).toHaveCount(1);
    // …and a band is drawn on the ruler in it.
    await page.getByTestId('column-scroll').evaluate((el) => (el.scrollTop = 0));
    const box = (await gap.boundingBox())!;
    await page.mouse.move(60, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(60, box.y + box.height * 0.8, { steps: 6 });
    await page.mouse.up();
    await expect(bench(page)).toHaveAttribute('data-entity', 'new-band');
    const bandName = field(page, 'name').locator('input');
    await expect(bandName).toBeFocused();
    await bandName.fill('Ember Shelf');
    await bandName.press('Enter');
    await leaveField(page);
    await expect(page.locator('[data-band="new-band"]')).toContainText('Ember Shelf');

    // Climate (W2): the new band has its tab; n adds a biome in its empty climate.
    await carbon.gotoView('climate', '2');
    await page.getByRole('tab', { name: 'Ember Shelf' }).click();
    await expect(page.locator('[data-testid="climate-region"]')).toHaveCount(0);
    await body(page).press('n');
    await expect(page.locator('[data-testid="climate-region"]')).toHaveCount(1);
    await expect(bench(page)).toHaveAttribute('data-entity', 'new-biome');
    const biomeName = field(page, 'name').locator('input');
    await biomeName.fill('Cinder Gardens');
    await biomeName.press('Enter');
    await leaveField(page);
    await expect(page.locator('[data-testid="climate-region"]')).toContainText('Cinder Gardens');

    // Codex (W2): n on the Materials tab adds a material and edits its name inline.
    await carbon.gotoView('codex', '3');
    await body(page).press('/');
    await page.getByTestId('codex-filter').fill('kind:material');
    await page.getByTestId('codex-filter').press('Enter');
    await expect(page.getByRole('tab', { selected: true })).toContainText('Materials');
    await body(page).press('n');
    const nameCell = page.locator('[data-entity="new-material"] td[data-col="name"] input');
    await expect(nameCell).toBeFocused();
    await nameCell.fill('Ember Salt');
    await nameCell.press('Enter');
    await expect(
      page.locator('[data-testid="codex-table"] tr[data-entity="new-material"]'),
    ).toContainText('Ember Salt');

    // Relate them on the Bench (W1's picker, the schema's rules): found in Cinder Gardens.
    await expect(bench(page)).toHaveAttribute('data-entity', 'new-material');
    const add = page.locator('[data-bench-field="relation"]');
    await add.getByRole('combobox', { name: 'Relation type' }).click();
    await page.getByRole('option', { name: 'found in' }).click();
    const to = add.getByRole('combobox', { name: 'Relate to' });
    await to.click();
    await page.keyboard.type('Cinder Gardens');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-rel="found_in:new-biome"]')).toBeVisible();
    await leaveField(page);

    // The Column shows it in the new band, inferred through the biome (W2's resolver).
    await carbon.gotoView('column', '1');
    const salt = chip(page, 'new-material');
    await expect(salt).toBeVisible();
    await expect(salt).toHaveAttribute('data-inferred', '');
    await expect(
      page.locator(
        '[data-testid="column-svg"] [data-cell="new-band|materials"] [data-id="new-material"]',
      ),
    ).toHaveCount(1);
    // And the Codex's band column agrees.
    const snap = await world(carbon);
    expect(snap.entities['new-material']?.relations).toEqual([
      { type: 'found_in', target: 'new-biome' },
    ]);
    expect(snap.entities['new-biome']?.fields.band).toBe('new-band');
    await expect
      .poll(() => read(carbon, 'entities/material/new-material.md'))
      .toContain('target: new-biome');
  });
});

test.describe('a spread from the Column', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon();
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  const openCards = (page: Page): Locator =>
    page.locator('[data-testid="spread-card"][data-state="open"]:not(.spread-card-out)');
  const cell = (page: Page, key: string): Locator =>
    page.locator(`[data-testid="column-svg"] [data-cell="${key}"] [data-id]`);

  test('space on a cell spreads there; keeps and a kill show on the Column; a merge undoes', async () => {
    const { page } = carbon;
    await carbon.gotoView('column', '1');
    await chip(page, 'glide').click();
    await expect(bench(page)).toHaveAttribute('data-entity', 'glide');
    const cellBefore = await cell(page, 'low-sky|capabilities').count();
    const idsBefore = new Set(Object.keys((await world(carbon)).entities));

    // The hand-off (W1 → W5): the Column cell arrives as the spot, with Fill.
    await body(page).press('Space');
    await expect(page.getByTestId('view-spread')).toBeVisible();
    await expect(page.getByTestId('spread-spot')).toHaveText('Low Sky · capabilities');
    await expect(page.getByTestId('spread-move-fill')).toHaveAttribute('aria-checked', 'true');
    await body(page).press('Enter');
    await expect(openCards(page)).toHaveCount(12);
    await expect(page.getByTestId('spread-progress')).toHaveCount(0);

    // Keep two, kill one with a reason (3: off-tone).
    await body(page).press('k');
    await expect(openCards(page)).toHaveCount(11);
    await body(page).press('k');
    await expect(openCards(page)).toHaveCount(10);
    await body(page).press('x');
    await expect(page.getByTestId('spread-kill-reasons')).toBeVisible();
    await page.keyboard.press('3');
    await expect(openCards(page)).toHaveCount(9);
    const w = await world(carbon);
    const kept = Object.values(w.entities).filter((e) => !idsBefore.has(e.id));
    expect(kept).toHaveLength(2);
    for (const e of kept) {
      expect(e.state).toBe('idea');
      expect(e.kind).toBe('capability');
      expect(e.relations).toContainEqual({ type: 'in_band', target: 'low-sky' });
    }
    expect(w.taste.reasons.find((r) => r.key === '3')?.count).toBe(1);

    // On the Column: both kept candidates in the cell the spread was aimed at.
    await carbon.gotoView('column', '1');
    await expect(cell(page, 'low-sky|capabilities')).toHaveCount(cellBefore + 2);
    for (const e of kept) await expect(chip(page, e.id)).toBeVisible();

    // Merge two more into one entity (one undo step), see it, then undo the merge.
    await carbon.gotoView('spread', '5');
    await expect(openCards(page)).toHaveCount(9);
    await body(page).press('Space');
    await body(page).press('Tab');
    await body(page).press('Space');
    await expect(page.locator('[data-testid="spread-card"][data-marked]')).toHaveCount(2);
    await body(page).press('m');
    await expect(openCards(page)).toHaveCount(7);
    const merged = Object.values((await world(carbon)).entities).filter(
      (e) => !idsBefore.has(e.id) && !kept.some((k) => k.id === e.id),
    );
    expect(merged).toHaveLength(1);
    await carbon.gotoView('column', '1');
    await expect(chip(page, merged[0]!.id)).toBeVisible();
    await expect(cell(page, 'low-sky|capabilities')).toHaveCount(cellBefore + 3);
    await body(page).press('Control+z');
    await expect(chip(page, merged[0]!.id)).toHaveCount(0);
    await expect(cell(page, 'low-sky|capabilities')).toHaveCount(cellBefore + 2);
    // The undo took the whole merge: the two candidates are open on the field again.
    await carbon.gotoView('spread', '5');
    await expect(openCards(page)).toHaveCount(9);
  });
});

test.describe('the Bench with the AI', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon();
    await carbon.gotoView('column', '1');
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('tab suggests, tab accepts with the ai marker, ctrl+z undoes it', async () => {
    const { page } = carbon;
    await chip(page, 'glide').click();
    const gates = field(page, 'gates').locator('input');
    await gates.click();
    await gates.fill('');
    await gates.press('Enter');
    await expect.poll(() => read(carbon, 'entities/capability/glide.md')).not.toContain('gates:');
    await page.keyboard.press('Tab');
    await expect(field(page, 'gates').locator('.ui-suggest-ghost')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('ai-marker-gates')).toBeVisible();
    await expect
      .poll(() => read(carbon, 'entities/capability/glide.md'))
      .toMatch(/ai_fields:\s*\n\s*- gates/);
    const log = await carbon.invoke('ai:log', {});
    expect(log.some((l) => l.moment === 'suggest_one' && l.entity === 'glide')).toBe(true);
    await leaveField(page);
    await body(page).press('Control+z');
    await expect(page.getByTestId('ai-marker-gates')).toHaveCount(0);
    await expect.poll(() => read(carbon, 'entities/capability/glide.md')).not.toContain('- gates');
  });

  test('finishing an edit critiques it once; the note shows on the Bench and in the margin', async () => {
    const { page } = carbon;
    const critiques = async (): Promise<number> =>
      (await carbon.invoke('ai:log', {})).filter(
        (l) => l.moment === 'critique' && l.entity === 'glide',
      ).length;
    await chip(page, 'glide').click();
    const before = await critiques();
    const identity = field(page, 'identity').locator('input');
    await identity.fill('Fly.');
    await identity.press('Enter');
    // Focus leaves the entity: that finishes the edit (one critique, not two).
    await chip(page, 'sunken-stair').click();
    await expect.poll(critiques).toBe(before + 1);
    await page.waitForTimeout(300);
    expect(await critiques()).toBe(before + 1);
    const margin = page.locator('[data-testid="column-margin"] .column-note[data-source="ai"]');
    await expect(margin.first()).toBeVisible();
    await chip(page, 'glide').click();
    // The critique's note (W4's gateway, W1's Bench) is on the Bench for this entity.
    await expect(
      page.getByTestId('bench-notes').locator('li[data-source="ai"]').first(),
    ).toBeVisible();
    // Mechanical checks (W6) share the Bench: an entity with a check note shows it there too.
    await open(page, 'Sky Coral', 'sky-coral');
    await expect(
      page.getByTestId('bench-notes').locator('li[data-source="check"]').first(),
    ).toBeVisible();
  });

  test('a kill from the Bench counts its reason in Taste, in the same undo step', async () => {
    const { page } = carbon;
    const count = async (): Promise<number | undefined> =>
      (await world(carbon)).taste.reasons.find((r) => r.key === '2')?.count;
    const before = (await count()) ?? 0;
    await chip(page, 'vent-glass').click();
    await page.getByTestId('bench-menu').click();
    await page.getByRole('menuitem', { name: 'Move to the graveyard…' }).click();
    await expect(page.getByTestId('kill-reasons')).toBeVisible();
    await page.keyboard.press('2');
    await expect(bench(page)).toHaveAttribute('data-state', 'graveyard');
    await expect.poll(count).toBe(before + 1);
    await body(page).press('Control+z');
    await expect(bench(page)).toHaveAttribute('data-state', 'idea');
    await expect.poll(count).toBe(before);
  });
});

test.describe('numbers into checks, decided into an export', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon();
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  const FORMULA =
    'band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)';
  const SOAK = 'soak(a: item) = a.defense * 3';

  test('a formula typed in Numbers; an attribute far off its intent curve raises a check note', async () => {
    const { page } = carbon;
    await carbon.gotoView('numbers', '4');
    const source = page.getByTestId('numbers-source');
    await source.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(`\n${FORMULA}\n${SOAK}\n`);
    await expect.poll(() => read(carbon, 'numbers/formulas.carbon')).toContain(SOAK);
    await source.blur();
    // A curve of it over the bands, armor as dots, and an intent of 20 everywhere.
    const r = await carbon.dispatch(
      cmd('numbers.putCurve', {
        curve: {
          id: 'defense',
          y: 'band_defense(x)',
          over: { axis: 'band' },
          dots: { query: 'items where subkind == "armor"', value: '.defense' },
          intent: ['undercroft', 'hollows', 'groundline', 'low-sky', 'high-drift'].map((x) => ({
            x,
            y: 20,
          })),
        },
      }),
    );
    expect(r.ok).toBe(true);
    await expect(page.locator('[data-curve="defense"] .plot-dot[data-off]')).toHaveCount(1);

    // The mechanical checks (W6) read the numbers engine (W3): a note at the visor.
    await carbon.gotoView('column', '1');
    const offCurve = page.locator(
      '[data-testid="column-margin"] .column-note[data-source="check"]',
      { hasText: 'is far off defense' },
    );
    await expect(offCurve).toHaveCount(1);
    await chip(page, 'vent-glass-visor').click();
    await expect(
      page.getByTestId('bench-notes').locator('li', { hasText: 'is far off defense' }),
    ).toHaveCount(1);
    // The Bench shows the attribute's live consequence (W3), then brings it onto the curve.
    await expect(page.getByTestId('bench-consequences')).toContainText('soak(Vent Glass Visor)12');
    const defense = field(page, 'attributes.defense').locator('input');
    await defense.fill('20');
    await defense.press('Enter');
    await leaveField(page);
    await expect(offCurve).toHaveCount(0);
    await expect(page.getByTestId('bench-consequences')).toContainText('soak(Vent Glass Visor)60');
  });

  test('a decided entity exports with the AI draft; the file is written and the entity marked exported', async () => {
    const { page } = carbon;
    // The visor's design is written (setup), then decided on the Bench: the Why gate,
    // with idea passing through shaped in one step.
    const r = await carbon.dispatch(
      cmd('entity.update', {
        id: 'vent-glass-visor',
        set: {
          change: 'you can look straight into heat',
          tradeoff: 'it fogs in the cold',
          moment: 'the first vent crossing',
          route: [{ text: 'grind vent glass', needs: ['vent-glass'] }],
        },
      }),
    );
    expect(r.ok).toBe(true);
    await carbon.gotoView('column', '1');
    await chip(page, 'vent-glass-visor').click();
    await body(page).press('d');
    await page.getByTestId('why-input').fill('Hollows armor that changes how you breathe.');
    await page.getByTestId('why-submit').click();
    await expect(bench(page)).toHaveAttribute('data-state', 'decided');

    // Export (W6): choose items, draft with the spec_draft moment (W4), write.
    await carbon.gotoView('export', '7');
    await page.getByTestId('export-kind-item').click();
    await expect(page.getByTestId('export-list')).toContainText('Vent Glass Visor');
    await page.getByTestId('export-draft').click();
    const editor = page.getByTestId('export-editor');
    await expect(editor).toHaveAttribute('data-ai', '');
    const log = await carbon.invoke('ai:log', {});
    expect(log.some((l) => l.moment === 'spec_draft')).toBe(true);
    await editor.press('Control+s');
    await expect(editor).toHaveCount(0);
    const dir = path.join(carbon.worldDir, 'exports');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const text = readFileSync(path.join(dir, files[0]!), 'utf8');
    expect(text).toContain('Vent Glass Visor');
    expect((await world(carbon)).entities['vent-glass-visor']?.state).toBe('exported');
    // The template spec (no AI) carries the formulas the entity depends on (W3).
    await page.getByTestId('export-kind-item').click();
    await body(page).press('Control+k');
    await page.keyboard.type('Use the spec template');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('export-editor')).toHaveValue(/## Formulas[\s\S]*band_defense/);
  });
});

test.describe('the palette and the outside world', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon();
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  /** Runs an action by its label through the palette. */
  async function run(page: Page, label: string): Promise<void> {
    await body(page).press('Control+k');
    const palette = page.getByTestId('palette');
    await expect(palette).toBeVisible();
    await page.keyboard.type(label);
    await expect(palette.locator('[data-highlighted]')).toContainText(label);
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
  }

  test('from every view, the palette reaches that view’s actions and every package’s global ones', async () => {
    const { page } = carbon;
    // Each view's own action, run from the palette, with its effect.
    await carbon.gotoView('column', '1');
    const zoom = await page.getByTestId('column').getAttribute('data-zoom');
    await run(page, 'Zoom in');
    await expect(page.getByTestId('column')).not.toHaveAttribute('data-zoom', zoom ?? '');

    await carbon.gotoView('climate', '2');
    const band = await page.getByRole('tab', { selected: true }).innerText();
    await run(page, 'Next band');
    await expect(page.getByRole('tab', { selected: true })).not.toHaveText(band);

    await carbon.gotoView('codex', '3');
    const kind = await page.getByRole('tab', { selected: true }).innerText();
    await run(page, 'Next kind');
    await expect(page.getByRole('tab', { selected: true })).not.toHaveText(kind);

    await carbon.gotoView('numbers', '4');
    const curves = await page.getByTestId('numbers-curve').count();
    await run(page, 'New curve');
    await expect(page.getByTestId('numbers-curve')).toHaveCount(curves + 1);

    await carbon.gotoView('spread', '5');
    await run(page, 'Change the spot');
    await expect(page.getByRole('combobox', { name: 'Spot' })).toBeVisible();
    await page.keyboard.press('Escape');

    await carbon.gotoView('taste', '6');
    const rules = await page.getByTestId('taste-rule').count();
    await run(page, 'New rule');
    await page.keyboard.type('Nothing glows without a reason.');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('taste-rule')).toHaveCount(rules + 1);
    await leaveField(page);

    await carbon.gotoView('export', '7');
    await run(page, 'Choose every decided entity');
    await expect(page.getByTestId('export-count')).not.toHaveText('0 entities');

    // Global actions are reachable from any view: the shell's, W4's AI log, W6's store.
    await run(page, 'Go to Column');
    await expect(page.getByTestId('view-column')).toBeVisible();
    await run(page, 'AI log');
    await expect(page.getByTestId('ai-log')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ai-log')).toHaveCount(0);
    await run(page, 'Snapshot the world to git now');
    await expect(page.locator('.ui-toast').first()).toBeVisible();
  });

  test('an external edit of an entity file shows on the Column and the Bench', async () => {
    const { page } = carbon;
    await carbon.gotoView('column', '1');
    await chip(page, 'glide').click();
    await leaveField(page);
    // An undoable step of carbon's own, written to disk before the outside edits the file.
    await carbon.dispatch(cmd('entity.update', { id: 'sunken-stair', set: { identity: 'Down.' } }));
    expect((await carbon.invoke('world:snapshot', null)).history.canUndo).toBe(true);
    await expect
      .poll(() => read(carbon, 'entities/structure/sunken-stair.md'))
      .toContain('identity: Down.');
    const file = path.join(carbon.worldDir, 'entities/capability/glide.md');
    const r = entityFromMarkdown(readFileSync(file, 'utf8'));
    if (!r.ok) throw new Error(r.error.message);
    writeFileSync(file, entityToMarkdown({ ...r.value, name: 'Long Glide' }));
    await expect(chip(page, 'glide')).toContainText('Long Glide');
    await expect(field(page, 'name').locator('input')).toHaveValue('Long Glide');
    // An external change isn't an undo step of carbon's: it clears the history instead.
    const snap = await carbon.invoke('world:snapshot', null);
    expect(snap.world.entities['glide']?.name).toBe('Long Glide');
    expect(snap.history.canUndo).toBe(false);
  });
});

test.describe('the real gateway path (CARBON_AI=replay)', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon({ env: { CARBON_AI: 'replay' } });
    await carbon.gotoView('column', '1');
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('the Bench’s tab suggestion and critique, and a spread, go through the real gateway', async () => {
    const { page } = carbon;
    await expect(page.getByTestId('status-ai')).toHaveAttribute('data-mode', /.+/);
    await chip(page, 'glide').click();
    const gates = field(page, 'gates').locator('input');
    await gates.click();
    await gates.fill('');
    await gates.press('Enter');
    await page.keyboard.press('Tab');
    await expect(field(page, 'gates').locator('.ui-suggest-ghost')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('ai-marker-gates')).toBeVisible();
    await leaveField(page);
    await body(page).press('?');
    await expect
      .poll(async () =>
        (await carbon.invoke('ai:log', {}))
          .filter((l) => l.entity === 'glide')
          .map((l) => l.moment),
      )
      .toEqual(expect.arrayContaining(['suggest_one', 'critique']));
    // With a real gateway, the budget is a palette action (W4).
    await body(page).press('Control+k');
    await page.keyboard.type('Set the AI budget');
    await expect(page.getByTestId('palette').locator('[data-highlighted]')).toContainText(
      'Set the AI budget',
    );
    await page.keyboard.press('Escape');
    // The request the gateway built (W4's builders, W5's for spreads) is in the AI log.
    const log = await carbon.invoke('ai:log', {});
    const req = await carbon.invoke('ai:request', {
      id: log.find((l) => l.moment === 'critique')!.id,
    });
    expect(req?.text).toContain('Glide');

    // A spread on the cell: W5's builder, streamed through the real gateway.
    await chip(page, 'glide').click();
    await leaveField(page);
    await body(page).press('Space');
    await expect(page.getByTestId('view-spread')).toBeVisible();
    await body(page).press('Enter');
    await expect(
      page.locator('[data-testid="spread-card"][data-state="open"]').first(),
    ).toBeVisible();
    await expect(page.getByTestId('spread-progress')).toHaveCount(0);
    const spreadLog = (await carbon.invoke('ai:log', {})).filter((l) => l.moment === 'spread');
    expect(spreadLog.length).toBe(1);
    const spreadReq = await carbon.invoke('ai:request', { id: spreadLog[0]!.id });
    expect(spreadReq?.text).toContain('Low Sky');
  });
});
