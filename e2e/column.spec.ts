import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmd } from '@core/commands/registry';
import { writeWorldDir } from '../src/main/store/world-dir';
import { stressWorld } from '../src/renderer/views/column/stress';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * W1: the Column and the Bench, driven by the keyboard and the mouse like a
 * person would, against the fake AI. Each describe block gets its own copy of
 * its world.
 */

const chip = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="column-svg"] [data-id="${id}"]`).first();
const bench = (page: Page): Locator => page.getByTestId('bench-entity');
const field = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="bench-entity"] [data-bench-field="${key}"]`);
const read = (c: CarbonApp, rel: string): string =>
  readFileSync(path.join(c.worldDir, rel), 'utf8');
const press = (page: Page, key: string): Promise<void> => page.keyboard.press(key);

async function focusOn(c: CarbonApp, id: string): Promise<void> {
  await chip(c.page, id).click();
  await expect(bench(c.page)).toHaveAttribute('data-entity', id);
}

test.describe('the Column', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon();
    await carbon.gotoView('column', '1');
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('@smoke shows bands on the log axis, lanes, the Inbox, and walks them with j/k/h/l', async () => {
    const { page } = carbon;
    const names = await page
      .locator('[data-testid="column-svg"] [data-band]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-band')));
    expect(names).toEqual(['high-drift', 'low-sky', 'groundline', 'hollows', 'undercroft']);
    await expect(page.getByTestId('column-zero')).toHaveCount(1);
    await expect(page.locator('.column-lane-head')).toHaveText([
      'Biomes',
      'Materials',
      'Creatures',
      'Structures',
      'Capabilities',
      'Items',
      'Feats',
    ]);
    await expect(page.getByTestId('column-inbox')).toContainText('Inbox');
    await expect(page.locator('[data-testid="column-inbox"] [data-id]')).toHaveCount(3);
    // Inferred placement is marked; explicit isn't.
    await expect(chip(page, 'lumen-spore')).toHaveAttribute('data-inferred', '');
    await expect(chip(page, 'glide')).not.toHaveAttribute('data-inferred', '');

    await focusOn(carbon, 'meadow-steps');
    await press(page, 'j');
    await expect(bench(page)).toHaveAttribute('data-entity', 'glowmoss-caverns');
    await press(page, 'l');
    await expect(bench(page)).toHaveAttribute('data-entity', 'lumen-spore');
    await press(page, 'j');
    await expect(bench(page)).toHaveAttribute('data-entity', 'vent-glass');
    await press(page, 'h');
    await expect(bench(page)).toHaveAttribute('data-entity', 'ash-vents');
    await expect(chip(page, 'ash-vents')).toHaveAttribute('data-cursor', '');
    await press(page, 'h');
    await expect(bench(page)).toHaveAttribute('data-entity', 'hollows');
    await focusOn(carbon, 'spore-lantern');
    await page.mouse.move(5, 5);
    await carbon.screenshot('column-sample');
  });

  test('n creates an entity in the cell, placed in its band, and the name is ready to type', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'moss-grazer');
    await press(page, 'n');
    await expect(bench(page)).toHaveAttribute('data-entity', 'new-creature');
    const name = field(page, 'name').locator('input');
    await expect(name).toBeFocused();
    await page.keyboard.type('Ember Moth');
    await press(page, 'Enter');
    await expect
      .poll(() => read(carbon, 'entities/creature/new-creature.md'))
      .toContain('name: Ember Moth');
    expect(read(carbon, 'entities/creature/new-creature.md')).toContain('target: hollows');
    await expect(chip(page, 'new-creature')).toBeVisible();
    await press(page, 'Escape');
    await expect(name).not.toBeFocused();
    await press(page, 'Control+z');
    await expect
      .poll(() => read(carbon, 'entities/creature/new-creature.md'))
      .toContain('name: New creature');
    await press(page, 'Control+z');
    await expect(chip(page, 'new-creature')).toHaveCount(0);
  });

  test('dragging a shared band edge moves both bands in one undo step', async () => {
    const { page } = carbon;
    const edge = page.locator('[data-edge="low-sky^groundline"] rect');
    const box = (await edge.boundingBox())!;
    await page.mouse.move(box.x + 300, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y - 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => read(carbon, 'entities/band/groundline.md')).not.toContain('y_top: 96');
    const top = Number(/y_top: (\d+)/.exec(read(carbon, 'entities/band/groundline.md'))?.[1]);
    expect(top).toBeGreaterThan(96);
    // The two files of the transaction are written one after the other (durably), so poll both.
    await expect.poll(() => read(carbon, 'entities/band/low-sky.md')).toContain(`y_bottom: ${top}`);
    await press(page, 'Control+z');
    await expect.poll(() => read(carbon, 'entities/band/groundline.md')).toContain('y_top: 96');
    await expect.poll(() => read(carbon, 'entities/band/low-sky.md')).toContain('y_bottom: 96');
  });

  test('alt+k and alt+j nudge the band edges from the keyboard', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'meadow-steps');
    await press(page, 'h');
    await expect(bench(page)).toHaveAttribute('data-entity', 'groundline');
    await press(page, 'Alt+k');
    await expect.poll(() => read(carbon, 'entities/band/groundline.md')).not.toContain('y_top: 96');
    await press(page, 'Alt+Shift+j');
    await expect
      .poll(() => read(carbon, 'entities/band/groundline.md'))
      .not.toContain('y_bottom: -64');
    await expect.poll(() => read(carbon, 'entities/band/hollows.md')).not.toContain('y_top: -64');
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    await expect.poll(() => read(carbon, 'entities/band/groundline.md')).toContain('y_top: 96');
    expect(read(carbon, 'entities/band/groundline.md')).toContain('y_bottom: -64');
  });

  test('a band is drawn on the ruler in unwritten heights, and n fills a gap', async () => {
    const { page } = carbon;
    const r = await carbon.dispatch(cmd('entity.delete', { id: 'high-drift' }));
    expect(r.ok).toBe(true);
    const gap = page.locator('[data-testid="column-svg"] [data-row="gap:0"]');
    await expect(gap).toHaveCount(1);
    await page.getByTestId('column-scroll').evaluate((el) => (el.scrollTop = 0));
    const box = (await gap.boundingBox())!;
    await page.mouse.move(60, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(60, box.y + box.height - 2, { steps: 6 });
    await page.mouse.up();
    await expect(bench(page)).toHaveAttribute('data-entity', 'new-band');
    await expect(field(page, 'name').locator('input')).toBeFocused();
    const file = read(carbon, 'entities/band/new-band.md');
    expect(Number(/y_bottom: (-?\d+)/.exec(file)?.[1])).toBe(640);
    expect(Number(/y_top: (-?\d+)/.exec(file)?.[1])).toBeGreaterThan(640);
    await press(page, 'Escape');
    await press(page, 'Control+z');
    await expect(page.locator('[data-band="new-band"]')).toHaveCount(0);
    await press(page, 'Control+z');
    await expect(page.locator('[data-band="high-drift"]')).toHaveCount(1);
  });

  test('lanes hide, show and save as layouts', async () => {
    const { page } = carbon;
    await page.getByTestId('column-lanes').click();
    await page.getByRole('menuitem', { name: 'Creatures' }).click();
    await expect(page.locator('.column-lane-head[data-lane="creatures"]')).toHaveCount(0);
    await press(page, 'Control+k');
    await page.keyboard.type('Save layout');
    await press(page, 'Enter');
    await page.getByTestId('column-layout-name').fill('No creatures');
    await press(page, 'Enter');
    await expect.poll(() => read(carbon, 'carbon.json')).toContain('No creatures');
    await press(page, 'Control+k');
    await page.keyboard.type('Show the Creatures lane');
    await press(page, 'Enter');
    await expect(page.locator('.column-lane-head[data-lane="creatures"]')).toHaveCount(1);
    await press(page, 'Control+k');
    await page.keyboard.type('Use layout No creatures');
    await press(page, 'Enter');
    await expect(page.locator('.column-lane-head[data-lane="creatures"]')).toHaveCount(0);
    await press(page, 'Control+z');
    await expect(page.locator('.column-lane-head[data-lane="creatures"]')).toHaveCount(1);
  });

  test('alt+h / alt+l move a lane', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'glide');
    await press(page, 'Alt+h');
    await expect(page.locator('.column-lane-head').nth(3)).toHaveText('Capabilities');
    await expect(page.locator('.column-lane-head[data-cursor]')).toHaveText('Capabilities');
    await press(page, 'Control+z');
    await expect(page.locator('.column-lane-head').nth(4)).toHaveText('Capabilities');
  });

  test('+ and − zoom around the view; 0 brings Y 0 back', async () => {
    const { page } = carbon;
    const zoom = async (): Promise<number> =>
      Number(await page.getByTestId('column').getAttribute('data-zoom'));
    const z0 = await zoom();
    await press(page, '+');
    await expect.poll(zoom).toBeGreaterThan(z0);
    await press(page, '-');
    await press(page, '-');
    await expect.poll(zoom).toBeLessThan(z0);
    await page.getByTestId('column-scroll').evaluate((el) => (el.scrollTop = 0));
    await press(page, '0');
    const zero = (await page.getByTestId('column-zero').boundingBox())!;
    const view = (await page.getByTestId('column-scroll').boundingBox())!;
    expect(Math.abs(zero.y - (view.y + view.height / 2))).toBeLessThan(40);
    await press(page, '+');
  });

  test('i jumps to the Inbox', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'glide');
    await press(page, 'i');
    await expect(bench(page)).toHaveAttribute('data-entity', 'sky-coral');
    await press(page, 'l');
    await press(page, 'l');
    await press(page, 'l');
    await press(page, 'l');
    // Items group by subkind: the accessory, then the weapon.
    await expect(bench(page)).toHaveAttribute('data-entity', 'cloud-anklet');
    await press(page, 'j');
    await expect(bench(page)).toHaveAttribute('data-entity', 'cinder-sting');
  });

  test('space starts a spread at the cell', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'glide');
    await press(page, 'Space');
    await expect(page.getByTestId('view-spread')).toBeVisible();
    await carbon.gotoView('column', '1');
  });

  test('notes sit in the margin at their height', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'vent-glass-visor');
    await press(page, '?');
    // The critique's note (the mechanical checks have notes in the margin too).
    const note = page
      .locator('[data-testid="column-margin"] .column-note[data-source="ai"]')
      .first();
    await expect(note).toBeVisible();
    const g = (await chip(page, 'vent-glass-visor').boundingBox())!;
    const n = (await note.boundingBox())!;
    expect(Math.abs(n.y - g.y)).toBeLessThan(60);
    await page.mouse.move(5, 5);
    await expect(page.locator('.ui-toast')).toHaveCount(0, { timeout: 15000 });
    await carbon.screenshot('column-notes');
  });
});

test.describe('the Bench', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon();
    await carbon.gotoView('column', '1');
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('@smoke tab suggests inline, tab accepts with the ai marker, and it undoes', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'glide');
    const gates = field(page, 'gates').locator('input');
    await gates.click();
    await gates.fill('');
    await press(page, 'Enter');
    await expect.poll(() => read(carbon, 'entities/capability/glide.md')).not.toContain('gates:');
    await press(page, 'Tab');
    await expect(field(page, 'gates').locator('.ui-suggest-ghost')).toBeVisible();
    await expect(gates).toBeFocused();
    await carbon.screenshot('column-bench-suggest');
    await press(page, 'Tab');
    await expect(page.getByTestId('ai-marker-gates')).toBeVisible();
    await expect
      .poll(() => read(carbon, 'entities/capability/glide.md'))
      .toMatch(/ai_fields:\s*\n\s*- gates/);
    await press(page, 'Escape');
    await press(page, 'Control+z');
    await expect(page.getByTestId('ai-marker-gates')).toHaveCount(0);
  });

  test('esc dismisses a suggestion; editing an AI field clears its marker', async () => {
    const { page } = carbon;
    const gates = field(page, 'gates').locator('input');
    await gates.click();
    await press(page, 'Tab');
    await expect(field(page, 'gates').locator('.ui-suggest-ghost')).toBeVisible();
    await press(page, 'Escape');
    await expect(field(page, 'gates').locator('.ui-suggest-ghost')).toHaveCount(0);
    await press(page, 'Tab');
    await press(page, 'Tab');
    await expect(page.getByTestId('ai-marker-gates')).toBeVisible();
    await gates.fill('the sky, at last');
    await press(page, 'Enter');
    await expect(page.getByTestId('ai-marker-gates')).toHaveCount(0);
    await expect
      .poll(() => read(carbon, 'entities/capability/glide.md'))
      .toContain('gates: the sky, at last');
  });

  test('shift+tab offers three; 2 picks the second', async () => {
    const { page } = carbon;
    const verb = field(page, 'verb').locator('input');
    await verb.click();
    await press(page, 'Shift+Tab');
    const three = page.getByTestId('three-verb');
    await expect(three.locator('li')).toHaveCount(3);
    const second = (await three.locator('.bench-three-value').nth(1).textContent()) ?? '';
    await carbon.screenshot('column-bench-three');
    await press(page, '2');
    await expect(three).toHaveCount(0);
    await expect(verb).toHaveValue(second);
    await expect(page.getByTestId('ai-marker-verb')).toBeVisible();
  });

  test('ctrl+enter proposes for empty fields, each accepted or rejected on its own', async () => {
    const { page } = carbon;
    await page.locator('[data-testid="column-inbox"] [data-id="sky-coral"]').click();
    await expect(bench(page)).toHaveAttribute('data-entity', 'sky-coral');
    await press(page, 'Control+Enter');
    await expect(page.getByTestId('bench-proposals')).toBeVisible();
    const proposals = page.locator('[data-testid^="proposal-"]');
    const n = await proposals.count();
    expect(n).toBeGreaterThan(2);
    await carbon.screenshot('column-bench-fill');
    await proposals.first().getByRole('button', { name: 'Accept' }).click();
    await expect(proposals).toHaveCount(n - 1);
    await proposals.first().getByRole('button', { name: 'Reject' }).click();
    await expect(proposals).toHaveCount(n - 2);
    await page.getByTestId('bench-accept-all').click();
    await expect(proposals).toHaveCount(0);
    await expect
      .poll(() => (read(carbon, 'entities/material/sky-coral.md').match(/^ {2}- /gm) ?? []).length)
      .toBeGreaterThan(0);
  });

  test('d asks for Why; missing fields are marked; deciding works once they are filled', async () => {
    const { page } = carbon;
    await page.locator('[data-testid="column-inbox"] [data-id="cloud-anklet"]').click();
    await expect(bench(page)).toHaveAttribute('data-entity', 'cloud-anklet');
    await press(page, 'd');
    await page.getByTestId('why-input').fill('One more step is the whole Low Sky.');
    await page.getByTestId('why-submit').click();
    await expect(field(page, 'change').locator('.ui-field-error')).toHaveText(
      'Needed to be decided',
    );
    await expect(bench(page)).toHaveAttribute('data-state', 'idea');
    for (const [k, v] of [
      ['change', 'one jump in mid-air'],
      ['tradeoff', 'you land louder'],
      ['moment', 'the first gap you can’t jump'],
    ] as const) {
      const input = field(page, k).locator('input');
      await input.fill(v);
      await press(page, 'Enter');
    }
    await field(page, 'route').getByRole('button').click();
    await press(page, 'Escape');
    await press(page, 'd');
    await expect(page.getByTestId('why-input')).toHaveValue('');
    await page.getByTestId('why-input').fill('One more step is the whole Low Sky.');
    await press(page, 'Control+Enter');
    await expect(bench(page)).toHaveAttribute('data-state', 'decided');
    await expect
      .poll(() => read(carbon, 'entities/item/cloud-anklet.md'))
      .toContain('why: One more step is the whole Low Sky.');
    // The state change critiques the entity (asynchronously).
    await expect
      .poll(async () =>
        (await carbon.invoke('ai:log', {})).some(
          (l) => l.moment === 'critique' && l.entity === 'cloud-anklet',
        ),
      )
      .toBe(true);
    await press(page, 'Control+z');
    await expect(bench(page)).toHaveAttribute('data-state', 'idea');
  });

  test('the graveyard takes a kill reason by its key', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'vent-glass');
    await page.getByTestId('bench-menu').click();
    await page.getByRole('menuitem', { name: 'Move to the graveyard…' }).click();
    await expect(page.getByTestId('kill-reasons')).toBeVisible();
    await press(page, '2');
    await expect(bench(page)).toHaveAttribute('data-state', 'graveyard');
    await expect
      .poll(() => read(carbon, 'entities/material/vent-glass.md'))
      .toContain('reason: seen it');
    await press(page, 'Control+z');
    await expect(bench(page)).toHaveAttribute('data-state', 'idea');
  });

  test('every field type edits through commands and persists', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'spore-lantern');
    // enum → the attributes that apply follow it
    await field(page, 'subkind').getByRole('combobox').click();
    await page.getByRole('option', { name: 'weapon' }).click();
    const damage = page.locator('[data-bench-field="attributes.damage"] input');
    await expect(damage).toBeVisible();
    await damage.fill('7');
    await press(page, 'Enter');
    await expect.poll(() => read(carbon, 'entities/item/spore-lantern.md')).toContain('damage: 7');
    await damage.fill('-3');
    await press(page, 'Enter');
    await expect(page.locator('[data-bench-field="attributes.damage"] .ui-field-error')).toHaveText(
      'At least 0',
    );
    // steps: a need picked for a step
    const need = field(page, 'route').getByRole('combobox', { name: 'What step 2 needs' });
    await need.click();
    await page.keyboard.type('Spore Shrine');
    await press(page, 'Enter');
    await expect
      .poll(() => read(carbon, 'entities/item/spore-lantern.md'))
      .toContain('- spore-shrine');
    // a band's heights and range
    await page.locator('[data-band="low-sky"]').click();
    await expect(bench(page)).toHaveAttribute('data-entity', 'low-sky');
    const top = field(page, 'y_top').locator('input');
    await top.fill('700');
    await press(page, 'Enter');
    await expect(field(page, 'y_top').locator('.ui-field-error')).toHaveCount(0);
    await expect.poll(() => read(carbon, 'entities/band/low-sky.md')).toContain('y_top: 700');
    await top.fill('high');
    await press(page, 'Enter');
    await expect(field(page, 'y_top').locator('.ui-field-error')).toHaveText('A height, or ±∞');
    await top.fill('640');
    await press(page, 'Enter');
    const dangerTo = field(page, 'danger').getByLabel('Danger to');
    await dangerTo.fill('9');
    await press(page, 'Enter');
    await expect.poll(() => read(carbon, 'entities/band/low-sky.md')).toMatch(/max: 9/);
    // a ref (biome → band) and a list (material properties)
    await focusOn(carbon, 'cloud-reef');
    await field(page, 'band').getByRole('combobox').click();
    await page.keyboard.type('High');
    await press(page, 'Enter');
    await expect(chip(page, 'cloud-reef')).toBeVisible();
    await expect
      .poll(() => read(carbon, 'entities/biome/cloud-reef.md'))
      .toContain('band: high-drift');
    const t = field(page, 'climate').getByLabel('temperature to');
    await t.fill('0.9');
    await press(page, 'Enter');
    await expect.poll(() => read(carbon, 'entities/biome/cloud-reef.md')).toContain('max: 0.9');
    await t.fill('2');
    await press(page, 'Enter');
    await expect(field(page, 'climate').locator('.ui-field-error')).toHaveText(
      'From 0 to 1, low end first',
    );
  });

  test('relations: the picker offers what the rules allow; chips remove', async () => {
    const { page } = carbon;
    await focusOn(carbon, 'moss-grazer');
    const add = page.locator('[data-bench-field="relation"]');
    await add.getByRole('combobox', { name: 'Relation type' }).click();
    await page.getByRole('option', { name: 'drops' }).click();
    const to = add.getByRole('combobox', { name: 'Relate to' });
    await to.click();
    await page.keyboard.type('Glide');
    await expect(page.getByRole('option')).toHaveCount(0); // a capability can't be dropped
    await to.fill('');
    await page.keyboard.type('Sky Coral');
    await press(page, 'Enter');
    await expect(page.locator('[data-rel="drops:sky-coral"]')).toBeVisible();
    await expect
      .poll(() => read(carbon, 'entities/creature/moss-grazer.md'))
      .toContain('target: sky-coral');
    await page.getByRole('button', { name: 'Remove Sky Coral' }).click();
    await expect(page.locator('[data-rel="drops:sky-coral"]')).toHaveCount(0);
    // incoming relations show from the other side
    await focusOn(carbon, 'lumen-spore');
    await expect(page.locator('[data-rel-in="drops:moss-grazer"]')).toContainText('dropped by');
  });

  test('finishing an edit (leaving the entity, or ctrl+s) runs a critique', async () => {
    const { page } = carbon;
    const critiques = async (): Promise<number> =>
      (await carbon.invoke('ai:log', {})).filter(
        (l) => l.moment === 'critique' && l.entity === 'sunken-stair',
      ).length;
    await focusOn(carbon, 'sunken-stair');
    const before = await critiques();
    const id = field(page, 'identity').locator('input');
    await id.fill('Stairs.');
    await press(page, 'Enter');
    await focusOn(carbon, 'glide');
    await expect.poll(critiques).toBe(before + 1);
    // Leaving without changes doesn't call the AI.
    await focusOn(carbon, 'sunken-stair');
    await focusOn(carbon, 'glide');
    await page.waitForTimeout(200);
    expect(await critiques()).toBe(before + 1);
    // ctrl+s finishes the edit without leaving.
    await focusOn(carbon, 'sunken-stair');
    await id.fill('Down.');
    await press(page, 'Control+s');
    await expect.poll(critiques).toBe(before + 2);
    await expect
      .poll(() => read(carbon, 'entities/structure/sunken-stair.md'))
      .toContain('identity: Down.');
    // The weak identity shows on the Bench and in the margin.
    await expect(page.getByTestId('bench-notes')).toContainText('sharper');
    await page.mouse.move(5, 5);
    await expect(page.locator('.ui-toast')).toHaveCount(0, { timeout: 15000 });
    await carbon.screenshot('column-bench');
  });
});

test.describe('an empty world', () => {
  let carbon: CarbonApp;
  test.beforeAll(async () => {
    carbon = await launchCarbon({ world: null });
    await carbon.gotoView('column', '1');
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('says what is missing and n adds a band', async () => {
    const { page } = carbon;
    await expect(page.locator('.column-empty')).toHaveText('No bands yet. n to add one.');
    await carbon.screenshot('column-empty');
    await press(page, 'n');
    await expect(bench(page)).toHaveAttribute('data-entity', 'new-band');
    await page.keyboard.type('Surface');
    await press(page, 'Enter');
    await expect(page.locator('.column-empty')).toHaveCount(0);
    await expect(page.locator('[data-band="new-band"]')).toContainText('Surface');
  });
});

test.describe('performance (SYSTEM §9)', () => {
  let carbon: CarbonApp;
  let tmp: string;
  test.beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'carbon-stress-'));
    await writeWorldDir(tmp, stressWorld(2000));
    carbon = await launchCarbon({ worldDir: tmp });
    await carbon.gotoView('column', '1');
    await expect(carbon.page.getByTestId('status-entities')).toHaveText('2000 entities');
  });
  test.afterAll(async () => {
    await carbon.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('2,000 entities pan at 50 fps or better', async () => {
    const { page } = carbon;
    await page.waitForTimeout(300);
    await carbon.screenshot('column-stress');
    const fps = await page.getByTestId('column-scroll').evaluate(
      (el) =>
        new Promise<number>((resolve) => {
          const start = performance.now();
          let frames = 0;
          const max = el.scrollHeight - el.clientHeight;
          el.scrollTop = 0;
          const tick = (t: number): void => {
            frames++;
            const p = (t - start) / 3000;
            el.scrollTop = max * (0.5 - 0.5 * Math.cos(p * Math.PI * 2));
            if (t - start < 3000) requestAnimationFrame(tick);
            else resolve((frames * 1000) / (t - start));
          };
          requestAnimationFrame(tick);
        }),
    );
    console.log(`column pan: ${fps.toFixed(1)} fps over 2,000 entities`);
    expect(fps).toBeGreaterThanOrEqual(50);
  });

  test('a command round-trips in under 16 ms', async () => {
    const { page } = carbon;
    // Let the pan test's rendering and GC settle; the first 5 runs warm up and aren't counted.
    await page.waitForTimeout(1000);
    const measure = (field: string): Promise<number[]> =>
      page.evaluate(async (f) => {
        const out: number[] = [];
        for (let i = 0; i < 35; i++) {
          const t0 = performance.now();
          const patched = new Promise<void>((resolve) => {
            const off = window.carbon.on('world:patch', () => {
              off();
              resolve();
            });
          });
          await window.carbon.invoke('world:dispatch', {
            commands: [
              { type: 'entity.setField', payload: { id: 'e-500', field: f, value: `Stress ${i}` } },
            ],
          });
          await patched;
          if (i >= 5) out.push(performance.now() - t0);
        }
        return out.sort((a, b) => a - b);
      }, field);
    // An edit the Column doesn't draw (identity), and one it redraws (the name on a chip).
    for (const f of ['identity', 'name']) {
      const times = await measure(f);
      const median = times[Math.floor(times.length / 2)]!;
      console.log(
        `command round trip (${f}): median ${median.toFixed(1)} ms, max ${times[times.length - 1]!.toFixed(1)} ms`,
      );
      expect(median).toBeLessThan(16);
    }
  });
});
