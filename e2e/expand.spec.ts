import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * Resizable panes and expandable text fields (docs/build-notes/expand.md):
 * the Bench's edge by mouse and keyboard, kept across a reload; a field's
 * large editor with its suggestions, commit and undo; the formula editor's
 * expanded mode with its errors and completions.
 */

let carbon: CarbonApp;
const page = (): Page => carbon.page;
const benchWidth = async (): Promise<number> =>
  Math.round((await page().getByTestId('bench').boundingBox())!.width);
const edge = (id: string): Locator => page().getByTestId(`pane-edge-${id}`);
const field = (key: string): Locator =>
  page().locator(`[data-testid="bench-entity"] [data-bench-field="${key}"]`);
const read = (rel: string): string => readFileSync(path.join(carbon.worldDir, rel), 'utf8');

async function drag(handle: Locator, dx: number, dy = 0): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page().mouse.move(x, y);
  await page().mouse.down();
  await page().mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page().mouse.move(x + dx, y + dy, { steps: 4 });
  await page().mouse.up();
}

async function focusOn(id: string): Promise<void> {
  await carbon.gotoView('codex', '3');
  await page().locator(`[data-entity="${id}"]`).first().click();
  await expect(page().getByTestId('bench-entity')).toHaveAttribute('data-entity', id);
}

test.beforeAll(async () => {
  carbon = await launchCarbon();
});
test.afterAll(async () => {
  await carbon.close();
});

test.describe('resizable panes', () => {
  test('@smoke the Bench edge drags, survives a reload, and double-click resets it', async () => {
    await carbon.gotoView('column', '1');
    expect(await benchWidth()).toBe(360);
    await drag(edge('bench'), -120);
    await expect.poll(benchWidth).toBe(480);
    await page().reload();
    await page().waitForSelector('[data-testid="status-entities"]');
    await expect.poll(benchWidth).toBe(480);
    await edge('bench').dblclick();
    await expect.poll(benchWidth).toBe(360);
  });

  test('the Bench stays within 300px and 60% of the window; far below the minimum hides it', async () => {
    await drag(edge('bench'), -2000);
    const max = Math.round((await page().evaluate(() => window.innerWidth)) * 0.6);
    await expect.poll(benchWidth).toBe(max);
    await edge('bench').dblclick();
    await drag(edge('bench'), 100);
    await expect.poll(benchWidth).toBe(300);
    await drag(edge('bench'), 260);
    await expect(page().getByTestId('bench')).toHaveCount(0);
    await page().locator('body').press('b');
    // It comes back at the width it had.
    await expect.poll(benchWidth).toBe(300);
    await edge('bench').dblclick();
    await expect.poll(benchWidth).toBe(360);
  });

  test('arrows on the focused edge step 16px, shift 64px; the palette widens the nearest pane', async () => {
    await edge('bench').focus();
    await page().keyboard.press('ArrowLeft');
    await expect.poll(benchWidth).toBe(376);
    await page().keyboard.press('Shift+ArrowLeft');
    await expect.poll(benchWidth).toBe(440);
    await page().keyboard.press('ArrowRight');
    await expect.poll(benchWidth).toBe(424);
    await page().keyboard.press('Control+k');
    await page().keyboard.type('Narrow panel');
    await page().keyboard.press('Enter');
    await expect.poll(benchWidth).toBe(360);
    await page().keyboard.press('Control+k');
    await page().keyboard.type('Widen panel');
    await page().keyboard.press('Enter');
    await expect.poll(benchWidth).toBe(424);
    await edge('bench').dblclick();
    await expect.poll(benchWidth).toBe(360);
  });

  test('the views have their own panes: Numbers, Spread, Taste, Export', async () => {
    const width = async (sel: string): Promise<number> =>
      Math.round((await page().locator(sel).boundingBox())!.width);
    await carbon.gotoView('numbers', '4');
    expect(await width('.numbers-side')).toBe(340);
    await drag(edge('numbers-side'), -60);
    await expect.poll(() => width('.numbers-side')).toBe(400);
    await carbon.gotoView('taste', '6');
    const rules = await width('[data-testid="taste-rules"]');
    await drag(edge('taste-rules'), 50);
    await expect.poll(() => width('[data-testid="taste-rules"]')).toBe(rules + 50);
    await carbon.gotoView('export', '7');
    await drag(edge('export-choose'), 40);
    await expect.poll(() => width('.export-choose')).toBe(400);
    await carbon.gotoView('spread', '5');
    const before = Math.round((await page().locator('.spread-detail').boundingBox())!.height);
    await drag(edge('spread-detail'), 0, -60);
    await expect
      .poll(async () => Math.round((await page().locator('.spread-detail').boundingBox())!.height))
      .toBeGreaterThan(before + 40);
    // Nothing of this is in the world.
    expect(read('carbon.json')).not.toContain('numbers-side');
  });
});

test.describe('expandable text fields', () => {
  test('@smoke a Bench field expands; tab suggests in it; ctrl+enter commits; one undo', async () => {
    await focusOn('glide');
    const original = await field('gates').locator('input').inputValue();
    await field('gates').locator('input').click();
    await page().keyboard.press('Control+Shift+E');
    const editor = page().getByTestId('expand-editor');
    await expect(editor).toBeFocused();
    await expect(field('gates')).toHaveAttribute('data-expanded', '');
    await expect(editor).toHaveValue(original);
    await carbon.screenshot('expand-bench-field');
    // Typed text, then the AI's suggestion over it: tab shows it, tab takes it.
    await page().keyboard.press('End');
    await page().keyboard.type(', and further');
    await page().keyboard.press('Tab');
    await expect(field('gates').locator('.ui-suggest-ghost')).toBeVisible();
    await expect(editor).toBeFocused();
    await page().keyboard.press('Tab');
    await expect(page().getByTestId('ai-marker-gates')).toBeVisible();
    const accepted = await editor.inputValue();
    expect(accepted).not.toBe(original);
    await page().keyboard.press('Control+Enter');
    await expect(field('gates')).not.toHaveAttribute('data-expanded', '');
    await expect(field('gates').locator('input')).toBeFocused();
    await expect(field('gates').locator('input')).toHaveValue(accepted);
    await expect
      .poll(() => read('entities/capability/glide.md'))
      .toMatch(/ai_fields:\s*\n\s*- gates/);
    await page().locator('body').press('Escape');
    await page().locator('body').press('Control+z');
    await expect(field('gates').locator('input')).toHaveValue(original);
    await expect(page().getByTestId('ai-marker-gates')).toHaveCount(0);
  });

  test('typing in the editor and ctrl+enter is one undo step; esc keeps the edit as the draft', async () => {
    const input = field('identity').locator('input');
    const original = await input.inputValue();
    await input.click();
    await page().keyboard.press('Control+Shift+E');
    const editor = page().getByTestId('expand-editor');
    await expect(editor).toBeFocused();
    // (ctrl+a is the Codex's select-all here, as in any field.)
    await editor.fill('Rides the updraft between bands');
    // esc closes and keeps the text in the field, not yet committed.
    await page().keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Rides the updraft between bands');
    expect(read('entities/capability/glide.md')).not.toContain('Rides the updraft');
    // Back in, then ctrl+enter commits it.
    await page().keyboard.press('Control+Shift+E');
    await expect(editor).toBeFocused();
    await page().keyboard.press('Control+Enter');
    await expect
      .poll(() => read('entities/capability/glide.md'))
      .toContain('Rides the updraft between bands');
    await page().locator('body').press('Escape');
    await page().locator('body').press('Control+z');
    await expect(input).toHaveValue(original);
  });

  test('a click outside closes the editor and goes no further', async () => {
    await field('identity').locator('input').click();
    await page().keyboard.press('Control+Shift+E');
    await expect(page().getByTestId('expand-editor')).toBeVisible();
    await page().getByTestId('rail-numbers').click();
    await expect(page().getByTestId('expand-editor')).toHaveCount(0);
    await expect(page().getByTestId('view-codex')).toBeVisible();
    await page().locator('body').press('Escape');
  });

  test('the expand button shows on hover, with its key in the tooltip', async () => {
    const input = field('identity').locator('input');
    await input.hover();
    const button = field('identity').getByRole('button', { name: 'Expand' });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page().getByTestId('expand-editor')).toBeFocused();
    await page().keyboard.press('Escape');
    await page().locator('body').press('Escape');
  });

  test('the formula editor expands with its errors and completions', async () => {
    await carbon.gotoView('numbers', '4');
    const source = page().getByTestId('numbers-source');
    await source.click();
    await page().keyboard.press('Control+Shift+E');
    const editor = page().getByTestId('numbers-editor');
    await expect(editor).toHaveAttribute('data-expanded', '');
    await expect(source).toBeFocused();
    const box = (await editor.boundingBox())!;
    expect(box.width).toBeGreaterThan(600);
    await page().keyboard.press('Control+End');
    await page().keyboard.type('bad = 2 + nope\n');
    await expect(page().getByTestId('numbers-marks').locator('mark')).toHaveText(['nope']);
    await page().keyboard.press('ArrowUp');
    await expect(page().getByTestId('numbers-problem')).toContainText('Unknown name nope');
    await carbon.screenshot('expand-formulas');
    // Completions still open, and esc closes them before the editor.
    await page().keyboard.press('End');
    await page().keyboard.type(' + ta');
    await expect(page().getByTestId('numbers-complete')).toBeVisible();
    await page().keyboard.press('Escape');
    await expect(page().getByTestId('numbers-complete')).toHaveCount(0);
    await expect(editor).toHaveAttribute('data-expanded', '');
    await page().keyboard.press('Escape');
    await expect(editor).not.toHaveAttribute('data-expanded', '');
    await expect(source).toBeFocused();
    await page().keyboard.press('Control+z');
    await source.blur();
  });

  test('a long text grows with its content, up to its limit', async () => {
    await focusOn('glide');
    await page().getByTestId('bench-add-field').click();
    await page().getByRole('menuitem', { name: 'Description' }).click();
    const area = field('description').locator('textarea');
    await expect(area).toBeFocused();
    const h0 = (await area.boundingBox())!.height;
    await page().keyboard.type('one\ntwo\nthree\nfour\nfive\nsix');
    const h1 = (await area.boundingBox())!.height;
    expect(h1).toBeGreaterThan(h0 + 30);
    await page().keyboard.type('\nmore'.repeat(60));
    const limit = await area.evaluate(
      (el) => el.closest<HTMLElement>('[data-pane]')!.clientHeight * 0.4,
    );
    expect((await area.boundingBox())!.height).toBeLessThanOrEqual(Math.ceil(limit) + 1);
    await area.fill('');
    await page().locator('body').press('Escape');
  });
});
