import { readdirSync, readFileSync } from 'node:fs';
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

test('codex bulk actions reach only the selected rows the filter shows, and say how many it hides', async () => {
  await carbon.gotoView('codex', '3');
  await filter('kind:material state:idea');
  expect(await rowIds()).toEqual(['sky-coral', 'vent-glass']);
  await body().press('Control+a');
  await expect(page().getByTestId('codex-selection')).toContainText('2');
  // Narrow the filter: vent-glass stays selected but hidden, and bulk state leaves it alone.
  await filter('kind:material state:idea sky');
  expect(await rowIds()).toEqual(['sky-coral']);
  await expect(page().getByTestId('codex-selection')).toContainText('1');
  await expect(page().getByTestId('codex-selection-hidden')).toHaveText('1 hidden');
  await body().press('s');
  await expect(page().getByTestId('codex-state-dialog')).toBeVisible();
  await body().press('g');
  await body().press('2');
  await expect(page().getByTestId('codex-state-dialog')).toHaveCount(0);
  const stateOf = (id: string): string =>
    /state: (\w+)/.exec(
      readFileSync(path.join(carbon.worldDir, `entities/material/${id}.md`), 'utf8'),
    )?.[1] ?? '';
  await expect.poll(() => stateOf('sky-coral')).toBe('graveyard');
  expect(stateOf('vent-glass')).toBe('idea');
  // Clearing the filter brings the hidden row back, still selected.
  await body().press('Control+z');
  await expect.poll(() => stateOf('sky-coral')).toBe('idea');
  await filter('kind:material state:idea');
  await expect(page().getByTestId('codex-selection')).toContainText('2');
  await expect(page().getByTestId('codex-selection-hidden')).toHaveCount(0);
  // With every selected row hidden, the keys act on the cursor row, as with no selection.
  await filter('kind:band');
  await expect(page().getByTestId('codex-selection-hidden')).toHaveText('2 hidden');
  await body().press('Escape');
  await expect(page().getByTestId('codex-selection')).toHaveCount(0);
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

test('codex edits a choice through the picker', async () => {
  await carbon.gotoView('codex', '3');
  await filter('kind:material');
  const cell = page().locator('[data-entity="sky-coral"] td[data-col="f:rarity"]');
  await cell.dblclick();
  const picker = cell.getByRole('combobox');
  await expect(picker).toBeFocused();
  await picker.fill('legen');
  await picker.press('Enter');
  await expect(cell).toHaveText('legendary');
  await body().press('Control+z');
  await expect(cell).toHaveText('rare');
  await filter('');
});

test('codex edits long text inline without losing its line breaks', async () => {
  await carbon.dispatch(
    cmd('entity.setField', {
      id: 'moss-grazer',
      field: 'behaviour',
      value: 'Grazes moss.\nScatters at noise.',
    }),
  );
  await carbon.gotoView('codex', '3');
  await filter('kind:creature');
  const cell = page().locator('[data-entity="moss-grazer"] td[data-col="f:behaviour"]');
  await expect(cell).toHaveText('Grazes moss.');
  await cell.dblclick();
  const editor = cell.locator('textarea, input');
  await editor.press('Control+End');
  await editor.pressSequentially(' Fast.');
  await editor.press('Enter');
  await expect
    .poll(() =>
      readFileSync(path.join(carbon.worldDir, 'entities/creature/moss-grazer.md'), 'utf8'),
    )
    .toMatch(/Grazes moss\.\n\s+Scatters at noise\. Fast\./);
  await body().press('Control+z');
  await body().press('Control+z');
  await filter('');
});

test("codex remembers each tab's sort and column widths", async () => {
  await carbon.gotoView('codex', '3');
  await filter('kind:band');
  const th = (col: string) => page().locator(`th[data-col="${col}"]`);
  // Sort by name, descending (o twice on the first column).
  for (let i = 0; i < 8; i++) await body().press('h');
  await expect(th('name')).toHaveClass(/codex-th-current/);
  await body().press('o');
  await body().press('o');
  await expect(th('name')).toHaveAttribute('aria-sort', 'descending');
  const sorted = await rowIds();
  // Widen the name column by keys, and the identity column by dragging its edge.
  const before = (await th('name').boundingBox())!.width;
  await body().press('>');
  await body().press('>');
  await expect.poll(async () => (await th('name').boundingBox())!.width).toBe(before + 48);
  const edge = (await th('identity').locator('.codex-resize').boundingBox())!;
  const idBefore = (await th('identity').boundingBox())!.width;
  await page().mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page().mouse.down();
  await page().mouse.move(edge.x + edge.width / 2 - 100, edge.y + edge.height / 2, { steps: 4 });
  await page().mouse.up();
  await expect.poll(async () => (await th('identity').boundingBox())!.width).toBe(idBefore - 100);
  // Another tab has its own; leaving the view and coming back keeps both.
  await filter('');
  await body().press(']');
  await expect(th('name')).not.toHaveAttribute('aria-sort', /.+/);
  await body().press('[');
  await carbon.gotoView('column', '1');
  await carbon.gotoView('codex', '3');
  await expect(th('name')).toHaveAttribute('aria-sort', 'descending');
  expect(await rowIds()).toEqual(sorted);
  expect((await th('name').boundingBox())!.width).toBe(before + 48);
  expect((await th('identity').boundingBox())!.width).toBe(idBefore - 100);
  const stored = await page().evaluate(() => localStorage.getItem('carbon.codex'));
  expect(JSON.parse(stored ?? '{}')).toMatchObject({
    tab: 'band',
    sort: { band: { col: 'name', dir: 'desc' } },
  });
  // Sorting and widths are the viewer's: nothing to undo in the world.
  await expect(page().getByTestId('status-notes')).toBeVisible();
  // Double-clicking an edge brings the default width back; o again turns the sort off.
  await th('identity').locator('.codex-resize').dblclick();
  await expect.poll(async () => (await th('identity').boundingBox())!.width).toBe(idBefore);
  await body().press('o');
  await expect(th('name')).not.toHaveAttribute('aria-sort', /.+/);
  await body().press('<');
  await body().press('<');
  await filter('');
});

test('codex stays virtualised with 2,000 entities', async () => {
  const materials = path.join(carbon.worldDir, 'entities/material');
  const filesBefore = readdirSync(materials).length;
  const many = Array.from({ length: 2000 }, (_, i) =>
    cmd('entity.create', {
      kind: 'material',
      name: `Ore ${String(i).padStart(4, '0')}`,
      fields: { rarity: i % 2 ? 'common' : 'rare' },
    }),
  );
  const r = await carbon.dispatch(...many);
  expect(r.ok).toBe(true);
  await carbon.gotoView('codex', '3');
  await filter('kind:material id:ore-');
  await expect(page().getByRole('tab', { selected: true })).toContainText('2000');
  const rendered = await page()
    .locator('[data-testid="codex-table"] tbody tr[data-entity]')
    .count();
  expect(rendered).toBeGreaterThan(10);
  expect(rendered).toBeLessThan(80);
  const t0 = Date.now();
  await body().press('Shift+G');
  await expect(page().locator('tr[data-entity="ore-1999"]')).toHaveAttribute('data-current', '');
  expect(Date.now() - t0).toBeLessThan(2000);
  await filter('kind:material id:ore- rarity:rare');
  await expect(page().getByRole('tab', { selected: true })).toContainText('1000');
  await body().press('Control+z');
  await filter('');
  await expect(page().locator('tr[data-entity="ore-0000"]')).toHaveCount(0);
  // The store writes 2,000 files and then removes them (a batch per transaction). Finish
  // only once that has reached the disk, or later tests that read files wait behind this
  // test's writes (on a busy machine, past their own timeouts).
  await expect.poll(() => readdirSync(materials).length, { timeout: 120_000 }).toBe(filesBefore);
});

test('codex screenshots', async () => {
  await carbon.dispatch(cmd('entity.update', { id: 'glide', set: { tags: ['sky'] } }));
  await carbon.gotoView('codex', '3');
  await filter('lane:items');
  await page()
    .locator('[data-entity="vent-glass-visor"] td[data-col="name"]')
    .click({
      modifiers: ['Control'],
    });
  await page()
    .locator('[data-entity="cloud-anklet"] td[data-col="name"]')
    .click({
      modifiers: ['Control'],
    });
  await expect(page().locator('.ui-toast')).toHaveCount(0, { timeout: 15_000 });
  await carbon.screenshot('world-codex');
  await filter('kind:creature menace:>lots');
  await carbon.screenshot('world-codex-error');
  await body().press('Escape');
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

test("climate: letters typed straight after n land in the new biome's name", async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Groundline' }).click();
  // n and the name in one burst, before the create command can round-trip.
  await page().evaluate(() => {
    for (const key of ['n', 'G', 'l', 'o', 'w'])
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  const name = page().getByTestId('bench-entity').locator('.bench-title-input');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Glow');
  await name.press('Enter');
  await expect(page().locator('[data-testid="climate-region"]', { hasText: 'Glow' })).toHaveCount(
    1,
  );
  await body().press('Escape');
  await body().press('Control+z');
  await body().press('Control+z');
  await expect(page().locator('[data-testid="climate-region"]')).toHaveCount(1);
});

test('climate escape and a click on the empty plane deselect the biome', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Groundline' }).click();
  await body().press('j');
  await expect(region('meadow-steps')).toHaveClass(/climate-region-selected/);
  await body().press('Escape');
  await expect(region('meadow-steps')).not.toHaveClass(/climate-region-selected/);
  // With nothing selected, arrows move nothing.
  await body().press('ArrowRight');
  await page().waitForTimeout(800);
  expect(climateOf('meadow-steps')).toMatch(/min: 0\.4\s+max: 0\.7/);
  await region('meadow-steps').click();
  await expect(region('meadow-steps')).toHaveClass(/climate-region-selected/);
  const plane = (await page().getByTestId('climate-plane').boundingBox())!;
  await page().mouse.click(plane.x + plane.width - 6, plane.y + 6);
  await expect(region('meadow-steps')).not.toHaveClass(/climate-region-selected/);
});

test('climate: a burst of arrow keys moves by every press, as one undo step', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Groundline' }).click();
  await body().press('j');
  await expect(region('meadow-steps')).toHaveClass(/climate-region-selected/);
  for (let i = 0; i < 3; i++) await page().keyboard.press('ArrowRight');
  await expect.poll(() => climateOf('meadow-steps')).toMatch(/min: 0\.55\s+max: 0\.85/);
  // A second burst (resizing from the wet corner) is a step of its own.
  for (let i = 0; i < 2; i++) await page().keyboard.press('Shift+ArrowUp');
  await expect
    .poll(() => climateOf('meadow-steps'))
    .toMatch(/moisture:\s+min: 0\.35\s+max: 0\.8\b/);
  await body().press('Control+z');
  await expect
    .poll(() => climateOf('meadow-steps'))
    .toMatch(/moisture:\s+min: 0\.35\s+max: 0\.7\b/);
  expect(climateOf('meadow-steps')).toMatch(/min: 0\.55\s+max: 0\.85/);
  await body().press('Control+z');
  await expect.poll(() => climateOf('meadow-steps')).toMatch(/min: 0\.4\s+max: 0\.7/);
});

test('climate actions are all in the palette, placing a biome without climate too', async () => {
  const runPalette = async (label: string): Promise<void> => {
    await body().press('Control+k');
    const palette = page().getByTestId('palette');
    await expect(palette).toBeVisible();
    await page().keyboard.type(label);
    await expect(palette.locator('[data-highlighted]')).toContainText(label);
    await page().keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
  };
  await carbon.dispatch(
    cmd('entity.create', {
      kind: 'biome',
      name: 'Fog Shelf',
      id: 'fog-shelf',
      fields: { band: 'groundline' },
    }),
    // New biomes get the schema's default climate: clear it, so this one waits under the plane.
    cmd('entity.setField', { id: 'fog-shelf', field: 'climate', value: null }),
  );
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Groundline' }).click();
  await expect(page().getByTestId('climate-loose')).toContainText('Fog Shelf');
  await runPalette('Place Fog Shelf on the plane');
  await expect(region('fog-shelf')).toBeVisible();
  await expect(region('fog-shelf')).toHaveClass(/climate-region-selected/);
  const placed = climateOf('fog-shelf');
  await runPalette('Move the biome warmer');
  await expect.poll(() => climateOf('fog-shelf')).not.toBe(placed);
  await body().press('Control+z');
  await body().press('Control+z');
  await expect(page().getByTestId('climate-loose')).toContainText('Fog Shelf');
  await body().press('Control+z');
});

test('climate: a biome made on a band without edges shows on its plane', async () => {
  await carbon.dispatch(cmd('entity.create', { kind: 'band', name: 'Aether', id: 'aether' }));
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Aether' }).click();
  await expect(page().getByTestId('climate-region')).toHaveCount(0);
  await body().press('n');
  await expect(page().getByTestId('bench-entity')).toHaveAttribute('data-entity', 'new-biome');
  await expect(region('new-biome')).toBeVisible();
  await body().press('Control+z');
  await expect(region('new-biome')).toHaveCount(0);
  await body().press('Control+z');
});

test('climate: a click or a drag faster than a render never leaves the plane stuck', async () => {
  await carbon.gotoView('climate', '2');
  await page().getByRole('tab', { name: 'Hollows' }).click();
  await expect(region('ash-vents')).toBeVisible();
  // Pointer events with no render between them, as on a busy machine: down, moves, up (the
  // mouse's own pointer, so pointer capture accepts it).
  await page().mouse.move(5, 5);
  const fire = (dx: number) =>
    page().evaluate((dx) => {
      const el = document.querySelector('[data-testid="climate-region"][data-entity="ash-vents"]')!;
      const plane = document.querySelector('[data-testid="climate-plane"]')!;
      const r = el.getBoundingClientRect();
      const w = plane.getBoundingClientRect().width;
      const at = (x: number) => ({
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        button: 0,
        buttons: 1,
        clientX: r.left + r.width / 2 + x,
        clientY: r.top + r.height / 2,
      });
      el.dispatchEvent(new PointerEvent('pointerdown', at(0)));
      for (const f of [0.25, 0.5, 0.75, 1])
        el.dispatchEvent(new PointerEvent('pointermove', at(dx * w * f)));
      el.dispatchEvent(new PointerEvent('pointerup', at(dx * w)));
    }, dx);
  // A quick click: nothing moves, and the keys still work afterwards.
  await fire(0);
  await body().press('ArrowLeft');
  await expect.poll(() => climateOf('ash-vents')).toMatch(/min: 0\.7\s+max: 0\.95/);
  await body().press('Control+z');
  await expect.poll(() => climateOf('ash-vents')).toMatch(/min: 0\.75\s+max: 1/);
  // A quick drag 10% colder: it lands where the pointer let go, as one step.
  await fire(-0.1);
  await expect.poll(() => climateOf('ash-vents')).toMatch(/min: 0\.65\s+max: 0\.9/);
  await body().press('Control+z');
  await expect.poll(() => climateOf('ash-vents')).toMatch(/min: 0\.75\s+max: 1/);
});

test('codex: a column resize faster than a render lands and never sticks', async () => {
  await carbon.gotoView('codex', '3');
  const th = page().locator('th[data-col="identity"]');
  const before = (await th.boundingBox())!.width;
  await page().mouse.move(5, 5);
  await page().evaluate(() => {
    const h = document.querySelector('th[data-col="identity"] .codex-resize')!;
    const r = h.getBoundingClientRect();
    const at = (x: number) => ({
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: r.left + r.width / 2 + x,
      clientY: r.top + r.height / 2,
    });
    h.dispatchEvent(new PointerEvent('pointerdown', at(0)));
    h.dispatchEvent(new PointerEvent('pointermove', at(20)));
    h.dispatchEvent(new PointerEvent('pointermove', at(40)));
    h.dispatchEvent(new PointerEvent('pointerup', at(40)));
  });
  await expect.poll(async () => (await th.boundingBox())!.width).toBe(before + 40);
  const stored = await page().evaluate(() => localStorage.getItem('carbon.codex'));
  const widths = (JSON.parse(stored ?? '{}') as { widths?: Record<string, Record<string, number>> })
    .widths;
  // Remembered for whichever tab is showing.
  expect(Object.values(widths ?? {}).some((w) => w.identity === before + 40)).toBe(true);
  await th.locator('.codex-resize').dblclick();
  await expect.poll(async () => (await th.boundingBox())!.width).toBe(before);
});

test('a tab click hands the keys back without taking them from what opens next', async () => {
  // Click a tab, then something else takes focus before the next frame (the palette opening on
  // ctrl+k right after the click): focus must stay there.
  const stolen = async (tab: string, view: string, key: string): Promise<boolean> => {
    await carbon.gotoView(view, key);
    return page().evaluate(async (name) => {
      const t = [...document.querySelectorAll('[role="tab"]')].find((x) =>
        x.textContent.startsWith(name),
      )!;
      t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      t.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
      const other = document.createElement('input');
      document.body.append(other);
      other.focus();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const kept = document.activeElement === other;
      other.remove();
      return !kept;
    }, tab);
  };
  expect(await stolen('Groundline', 'climate', '2')).toBe(false);
  expect(await stolen('All', 'codex', '3')).toBe(false);
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
  await expect(page().locator('.ui-toast')).toHaveCount(0, { timeout: 15_000 });
  await carbon.screenshot('world-climate');
  await body().press('Control+z');
});
