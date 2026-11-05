import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * Critique and generation agree (docs/SYSTEM.md §8a): accepting AI values
 * alone never asks the critic to judge them; your own edit does; a note on a
 * field the AI wrote offers Rewrite, and accepting the rewrite is one undo step.
 * Against the fake AI.
 */

let carbon: CarbonApp;
test.beforeAll(async () => {
  carbon = await launchCarbon();
  await carbon.gotoView('column', '1');
});
test.afterAll(async () => {
  await carbon.close();
});

const bench = (page: Page): Locator => page.getByTestId('bench-entity');
const field = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="bench-entity"] [data-bench-field="${key}"]`);
const read = (rel: string): string => readFileSync(path.join(carbon.worldDir, rel), 'utf8');

async function focus(name: string, id: string): Promise<void> {
  const { page } = carbon;
  await page.locator('body').press('Control+k');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(bench(page)).toHaveAttribute('data-entity', id);
}

const critiques = async (id: string): Promise<number> =>
  (await carbon.invoke('ai:log', {})).filter((l) => l.moment === 'critique' && l.entity === id)
    .length;

test('fill, accept every proposal, leave: no critique; your edit, leave: a critique', async () => {
  const { page } = carbon;
  await focus('Sky Coral', 'sky-coral');
  const before = await critiques('sky-coral');
  await page.locator('body').press('Control+Enter');
  await expect(page.getByTestId('bench-proposals')).toBeVisible();
  await page.getByTestId('bench-accept-all').click();
  await expect(page.locator('[data-testid^="proposal-"]')).toHaveCount(0);
  await expect.poll(() => read('entities/material/sky-coral.md')).toMatch(/ai_fields:\s*\n\s*- /);
  // Leaving after only AI changes: nothing of yours to judge.
  await focus('Glide', 'glide');
  await page.waitForTimeout(400);
  expect(await critiques('sky-coral')).toBe(before);
  // ctrl+s doesn't either.
  await focus('Sky Coral', 'sky-coral');
  await page.locator('body').press('Control+s');
  await page.waitForTimeout(300);
  expect(await critiques('sky-coral')).toBe(before);
  // One field you edit, then leave: a critique.
  const identity = field(page, 'identity').locator('input');
  await identity.fill('Coral that only grows where clouds condense on it.');
  await identity.press('Enter');
  await focus('Glide', 'glide');
  await expect.poll(() => critiques('sky-coral')).toBe(before + 1);
});

test('a note on an AI field offers Rewrite; the rewrite lands in the field and one undo restores it', async () => {
  const { page } = carbon;
  const r = await carbon.dispatch({
    type: 'entity.setField',
    payload: { id: 'sunken-stair', field: 'identity', value: 'Odd.', source: 'ai' },
  });
  expect(r.ok).toBe(true);
  await focus('Sunken Stair', 'sunken-stair');
  await expect(page.getByTestId('ai-marker-identity')).toBeVisible();
  await page.locator('body').press('?');
  const note = page.getByTestId('bench-notes').locator('li[data-source="ai"]', {
    hasText: 'sharper',
  });
  await expect(note).toBeVisible();
  // The palette lists it too.
  await page.locator('body').press('Control+k');
  await page.keyboard.type('Rewrite identity');
  await expect(page.getByTestId('palette').locator('[data-highlighted]')).toContainText(
    'Rewrite identity',
  );
  await page.keyboard.press('Escape');
  const suggestions = async (): Promise<string[]> =>
    (await carbon.invoke('ai:log', {}))
      .filter((l) => l.moment === 'suggest_one' && l.entity === 'sunken-stair')
      .map((l) => l.id);
  const asked = (await suggestions()).length;
  const identity = field(page, 'identity').locator('input');
  // r asks for the rewrite; esc dismisses it and the note stays.
  await page.locator('body').press('r');
  await expect.poll(async () => (await suggestions()).length).toBe(asked + 1);
  await expect(field(page, 'identity').locator('.ui-suggest-ghost')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(field(page, 'identity').locator('.ui-suggest-ghost')).toHaveCount(0);
  await expect(identity).toHaveValue('Odd.');
  await expect(note).toBeVisible();
  // The note's button asks again.
  await note.getByTestId('note-rewrite').click();
  await expect.poll(async () => (await suggestions()).length).toBe(asked + 2);
  await expect(field(page, 'identity').locator('.ui-suggest-ghost')).toBeVisible();
  await expect(identity).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(identity).not.toHaveValue('Odd.');
  const rewritten = await identity.inputValue();
  expect(rewritten.length).toBeGreaterThan(4);
  await expect.poll(() => read('entities/structure/sunken-stair.md')).toContain(rewritten);
  // The note it answered is withdrawn; the value is still the AI's.
  await expect(note).toHaveCount(0);
  await expect(page.getByTestId('ai-marker-identity')).toBeVisible();
  // One undo restores the AI's old value.
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Control+z');
  await expect(identity).toHaveValue('Odd.');
  await expect.poll(() => read('entities/structure/sunken-stair.md')).toContain('identity: Odd.');
});
