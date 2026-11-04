import { expect, test, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * Spreads and Taste (package W5), end to end on the sample world with the fake
 * AI: aim, stream, triage with the keyboard, undo, merge, follow, taste.
 */

let carbon: CarbonApp;
const page = (): Page => carbon.page;
const cards = () => page().getByTestId('spread-card');
const openCards = () =>
  page().locator('[data-testid="spread-card"][data-state="open"]:not(.spread-card-out)');

async function world() {
  const snap = await carbon.invoke('world:snapshot', null);
  return snap.world;
}

/** Aims the spread with the spot picker (`s`), by the spot's name. */
async function aim(name: string): Promise<void> {
  await page().locator('body').press('s');
  const box = page().getByRole('combobox', { name: 'Spot' });
  await box.fill(name);
  await box.press('Enter');
  await expect(page().getByTestId('spread-spot')).toHaveText(name);
}

async function spread(count = 12): Promise<void> {
  await page().locator('body').press('Enter');
  await expect(openCards()).toHaveCount(count);
  await expect(page().getByTestId('spread-progress')).toHaveCount(0);
}

test.describe('spreads', () => {
  test.beforeAll(async () => {
    carbon = await launchCarbon();
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('@smoke streams a Fill spread onto the field and triages it with k, x and u', async () => {
    await carbon.gotoView('spread', '5');
    await aim('Low Sky · items');
    await expect(page().getByTestId('spread-move-fill')).toHaveAttribute('aria-checked', 'true');
    await spread();
    await expect(page().locator('[data-testid="spread-card"][data-wildcard]')).toHaveCount(1);
    const before = Object.keys((await world()).entities).length;

    // k keeps the focused candidate as an idea at the spot.
    const first = await page()
      .locator('[data-testid="spread-card"][data-focused]')
      .getAttribute('data-key');
    await page().locator('body').press('k');
    await expect(openCards()).toHaveCount(11);
    let w = await world();
    expect(Object.keys(w.entities).length).toBe(before + 1);
    const kept = Object.values(w.entities).find((e) => e.origin.spread !== undefined);
    expect(kept?.relations).toContainEqual({ type: 'in_band', target: 'low-sky' });
    expect(kept?.state).toBe('idea');

    // x then a reason key kills it, and the reason is counted.
    await page().locator('body').press('x');
    await expect(page().getByTestId('spread-kill-reasons')).toBeVisible();
    await carbon.screenshot('spreads-kill');
    await page().keyboard.press('3');
    await expect(openCards()).toHaveCount(10);
    w = await world();
    expect(w.taste.reasons.find((r) => r.key === '3')?.count).toBe(1);
    // The digit did not switch views.
    await expect(page().getByTestId('view-spread')).toBeVisible();

    // u undoes one step at a time: the kill, then the keep.
    await page().locator('body').press('u');
    await expect(openCards()).toHaveCount(11);
    expect((await world()).taste.reasons.find((r) => r.key === '3')?.count).toBe(0);
    await page().locator('body').press('u');
    await expect(openCards()).toHaveCount(12);
    expect(Object.keys((await world()).entities).length).toBe(before);
    await expect(
      page().locator(`[data-testid="spread-card"][data-key="${first ?? ''}"]`),
    ).toHaveCount(1);
  });

  test('saves the spread record in the world directory', async () => {
    const dir = path.join(carbon.worldDir, 'spreads');
    await expect
      .poll(() => readdirSync(dir).filter((f) => f.endsWith('.json')).length)
      .toBeGreaterThan(0);
    const file = readdirSync(dir).find((f) => f.includes('low-sky-items'));
    expect(file).toBeDefined();
    const rec = JSON.parse(readFileSync(path.join(dir, file ?? ''), 'utf8')) as {
      move: string;
      candidates: unknown[];
      spot: unknown;
    };
    expect(rec.move).toBe('fill');
    expect(rec.candidates).toHaveLength(12);
    expect(rec.spot).toEqual({ type: 'cell', band: 'low-sky', lane: 'items' });
  });

  test('kills with "other" and a few typed words', async () => {
    await page().locator('body').press('x');
    await page().keyboard.press('0');
    const words = page().getByTestId('spread-kill-other').getByRole('textbox');
    await expect(words).toBeFocused();
    await words.fill('too cute');
    await words.press('Enter');
    await expect(openCards()).toHaveCount(11);
    const w = await world();
    const rec = Object.values(w.spreads).find((s) => s.id.includes('low-sky-items')) as unknown as {
      judgements: Record<string, { verdict: string; note?: string }>;
    };
    expect(Object.values(rec.judgements)).toContainEqual(
      expect.objectContaining({ verdict: 'kill', note: 'too cute' }),
    );
  });

  test('marks with space and merges with m as one undo step', async () => {
    const before = Object.keys((await world()).entities).length;
    await page().locator('body').press('Space');
    await page().locator('body').press('Tab');
    await page().locator('body').press('Space');
    await expect(page().locator('[data-testid="spread-card"][data-marked]')).toHaveCount(2);
    await page().locator('body').press('m');
    await expect(openCards()).toHaveCount(9);
    expect(Object.keys((await world()).entities).length).toBe(before + 1);
    await page().locator('body').press('u');
    await expect(openCards()).toHaveCount(11);
    expect(Object.keys((await world()).entities).length).toBe(before);
  });

  test('follows a candidate with → and a move key', async () => {
    await page().locator('body').press('ArrowRight');
    await expect(page().getByTestId('spread-follow-moves')).toBeVisible();
    await page().keyboard.press('v');
    await expect(openCards()).toHaveCount(12);
    await expect(page().getByTestId('spread-move-vary')).toHaveAttribute('aria-checked', 'true');
    const w = await world();
    const followed = Object.values(w.spreads).find(
      (s) => (s as { parent?: unknown }).parent !== undefined,
    );
    expect(followed).toBeDefined();
  });

  test('shows near-duplicates as hairlines and screenshots the field', async () => {
    await aim('Low Sky · items');
    await page().locator('body').press('e');
    await page().keyboard.type('things that make the sky feel smaller');
    await page().keyboard.press('Enter');
    await expect(openCards()).toHaveCount(12);
    await page().locator('body').press('Tab');
    await page().locator('body').press('Tab');
    await carbon.screenshot('spreads-field');
  });
});

test.describe('moves, findings and pattern learning', () => {
  test.beforeAll(async () => {
    carbon = await launchCarbon();
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('a kept Break finding becomes a note, and undo takes it away', async () => {
    await carbon.gotoView('spread', '5');
    await aim('Glide');
    await expect(page().getByTestId('spread-move-vary')).toHaveAttribute('aria-checked', 'true');
    await expect(page().getByTestId('spread-move-fill')).toBeDisabled();
    await page().locator('body').press('r');
    await expect(page().getByTestId('spread-move-break')).toHaveAttribute('aria-checked', 'true');
    await spread();
    const before = Object.keys((await world()).entities).length;
    await page().locator('body').press('k');
    await expect(openCards()).toHaveCount(11);
    await expect(page().getByTestId('status-line')).toContainText('1 note');
    expect(Object.keys((await world()).entities).length).toBe(before);
    await page().locator('body').press('u');
    await expect(page().getByTestId('status-line')).not.toContainText('note');
  });

  test('Ground changes the entity it is about instead of making a new one', async () => {
    await aim('Cloud Anklet');
    await page().locator('body').press('g');
    await spread();
    const before = await world();
    await page().locator('body').press('k');
    await expect(openCards()).toHaveCount(11);
    const after = await world();
    expect(Object.keys(after.entities).length).toBe(Object.keys(before.entities).length);
    const judged = Object.values(after.spreads)
      .flatMap((sp) =>
        Object.values(
          (sp as unknown as { judgements: Record<string, { entity?: string }> }).judgements,
        ),
      )
      .filter((j) => j.entity === 'cloud-anklet');
    expect(judged).toHaveLength(1);
  });

  test('after 25 judgements the patterns moment runs by itself', async () => {
    await aim('Hollows · items');
    await page().locator('body').press('Enter');
    await expect(openCards()).toHaveCount(12);
    // 1 judged above (the Ground keep); 24 more across two spreads.
    for (let i = 0; i < 12; i++) await page().locator('body').press('k');
    await expect(openCards()).toHaveCount(0);
    await aim('Hollows · materials');
    await page().locator('body').press('Enter');
    await expect(openCards()).toHaveCount(12);
    for (let i = 0; i < 12; i++) {
      await page().locator('body').press('x');
      await page().keyboard.press(i % 2 ? '2' : '5');
    }
    await expect(page().getByText(/patterns? to review/)).toBeVisible();
    const w = await world();
    expect(w.taste.patterns.length).toBeGreaterThan(0);
    expect((w.settings as { patterns?: { judged?: number } }).patterns?.judged).toBe(25);
  });

  test('with the AI off, the field says so and nothing runs', async () => {
    await page().locator('body').press('Control+Shift+a');
    await aim('Low Sky · feats');
    await expect(page().getByTestId('spread-ai-off')).toBeVisible();
    await expect(page().getByTestId('spread-run')).toBeDisabled();
    await page().locator('body').press('Control+Shift+a');
    await expect(page().getByTestId('spread-run')).toBeEnabled();
  });
});

test.describe('streaming', () => {
  test.beforeAll(async () => {
    carbon = await launchCarbon({ env: { CARBON_AI_DELAY_MS: '120' } });
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('candidates arrive one by one, and escape stops the stream keeping what came', async () => {
    await carbon.gotoView('spread', '5');
    await aim('Hollows · creatures');
    await page().locator('body').press('Enter');
    await expect(page().getByTestId('spread-progress')).toBeVisible();
    await expect.poll(async () => cards().count()).toBeGreaterThan(1);
    await carbon.screenshot('spreads-streaming');
    await page().locator('body').press('Escape');
    await expect(page().getByTestId('spread-progress')).toHaveCount(0);
    const n = await openCards().count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(12);
    const w = await world();
    const rec = Object.values(w.spreads).find((s) =>
      s.id.includes('hollows-creatures'),
    ) as unknown as {
      status: string;
      candidates: unknown[];
    };
    expect(rec.status).toBe('cancelled');
    expect(rec.candidates).toHaveLength(n);
  });
});

test.describe('taste', () => {
  test.beforeAll(async () => {
    carbon = await launchCarbon();
  });
  test.afterAll(async () => {
    await carbon.close();
  });

  test('@smoke edits rules and kill reasons, with undo', async () => {
    await carbon.gotoView('taste', '6');
    const rules = page().getByTestId('taste-rule');
    await expect(rules).toHaveCount(1);
    await page().locator('body').press('n');
    await expect(page().getByTestId('taste-new-rule')).toBeFocused();
    await page().keyboard.type('Every item changes a verb.');
    await page().keyboard.press('Enter');
    await expect(rules).toHaveCount(2);
    await page().getByTestId('taste-new-rule').press('Escape');
    // Switch the first rule off with space.
    await page().locator('body').press('Space');
    await expect(rules.first().getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    let w = await world();
    expect(w.taste.rules.map((r) => [r.text, r.enabled])).toEqual([
      ['Nothing is just a bigger number.', false],
      ['Every item changes a verb.', true],
    ]);
    await page().locator('body').press('Control+z');
    await expect(rules.first().getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    // A new kill reason on the free key 8, then rename it inline.
    await page().getByTestId('taste-new-reason').fill('too cute');
    await page().getByTestId('taste-new-reason').press('Enter');
    await expect(page().getByTestId('taste-reason')).toHaveCount(9);
    await page().getByTestId('taste-new-reason').press('Escape');
    await page().locator('body').press('l');
    for (let i = 0; i < 7; i++) await page().locator('body').press('j');
    await page().locator('body').press('Enter');
    const edit = page().getByRole('textbox', { name: 'Reason', exact: true });
    await edit.fill('twee');
    await edit.press('Enter');
    w = await world();
    expect(w.taste.reasons.find((r) => r.key === '8')?.label).toBe('twee');
  });

  test('learns patterns on demand from judgements, then promotes and dismisses', async () => {
    // Judge a few candidates in a spread first.
    await carbon.gotoView('spread', '5');
    await aim('Hollows · items');
    await spread();
    for (const reason of ['1', '1', '3']) {
      await page().locator('body').press('x');
      await page().keyboard.press(reason);
    }
    await page().locator('body').press('k');
    await expect(openCards()).toHaveCount(8);
    await carbon.gotoView('taste', '6');
    await expect(page().getByTestId('taste-since')).toHaveText('4/25');
    const counts = page().getByTestId('taste-reason-count');
    await expect(counts.first()).toHaveText('2');
    await page().getByTestId('taste-learn').click();
    const patterns = page().getByTestId('taste-pattern');
    await expect(patterns).toHaveCount(2);
    await expect(page().getByTestId('taste-since')).toHaveCount(0);
    await carbon.screenshot('spreads-taste');
    await patterns.first().getByTestId('taste-promote').click();
    await expect(page().getByTestId('taste-rule')).toHaveCount(3);
    await expect(patterns.first()).toHaveAttribute('data-status', 'proposed');
    await page()
      .locator('[data-testid="taste-pattern"][data-status="proposed"]')
      .getByTestId('taste-dismiss')
      .click();
    await expect(
      page().locator('[data-testid="taste-pattern"][data-status="dismissed"]'),
    ).toHaveCount(0);
    const w = await world();
    expect(w.taste.patterns.map((p) => p.status).sort()).toEqual(['dismissed', 'promoted']);
  });

  test('a rule starts an Oppose spread with o', async () => {
    await page().locator('body').press('h');
    await page().locator('body').press('h');
    await page().locator('body').press('o');
    await expect(page().getByTestId('view-spread')).toBeVisible();
    await expect(page().getByTestId('spread-move-oppose')).toHaveAttribute('aria-checked', 'true');
    await expect(page().getByTestId('spread-spot')).toHaveText('Nothing is just a bigger number.');
  });
});
