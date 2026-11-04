import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cmd } from '@core/commands/registry';
import { launchCarbon, type CarbonApp } from './harness';

const VIEWS = [
  ['column', '1'],
  ['climate', '2'],
  ['codex', '3'],
  ['numbers', '4'],
  ['spread', '5'],
  ['taste', '6'],
  ['export', '7'],
] as const;

let carbon: CarbonApp;
test.beforeAll(async () => {
  carbon = await launchCarbon();
});
test.afterAll(async () => {
  await carbon.close();
});

test('@smoke opens the sample world in a frameless window with the shell', async () => {
  const { page, app } = carbon;
  await expect(page.getByTestId('status-entities')).toHaveText('24 entities');
  await expect(page.getByTestId('status-ai')).toContainText('(fake)');
  await expect(page.getByTestId('status-save')).toContainText('saved');
  // The renderer is isolated: no Node, only the typed bridge.
  const isolation = await page.evaluate(() => ({
    node: typeof (globalThis as { require?: unknown }).require,
    bridge: typeof window.carbon.invoke,
  }));
  expect(isolation).toEqual({ node: 'undefined', bridge: 'function' });
  const title = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getTitle(),
  );
  expect(title).toBe('carbon');
  await expect(page.getByTestId('bench')).toBeVisible();
});

test('@smoke switches views with 1–7 and screenshots each', async () => {
  for (const [id, key] of VIEWS) {
    await carbon.gotoView(id, key);
    await expect(page().getByTestId(`rail-${id}`)).toHaveAttribute('aria-current', 'page');
    await carbon.screenshot(`foundation-${id}`);
  }
  await carbon.gotoView('column', '1');
  await expect(page().getByTestId('column-bands').locator('li').first()).toContainText(
    'High Drift',
  );
});

test('@smoke toggles the Bench with b and focuses an entity from the Codex', async () => {
  await carbon.gotoView('codex', '3');
  await page().locator('[data-entity="glide"]').click();
  await expect(page().getByTestId('bench-entity')).toHaveAttribute('data-entity', 'glide');
  await page().locator('body').press('b');
  await expect(page().getByTestId('bench')).toHaveCount(0);
  await page().locator('body').press('b');
  await expect(page().getByTestId('bench-entity')).toContainText('Glide');
});

test('@smoke commands round-trip through IPC, persist to disk and undo with ctrl+z', async () => {
  const file = path.join(carbon.worldDir, 'entities/item/glass-lung.md');
  const r = await carbon.dispatch(
    cmd('entity.create', { kind: 'item', name: 'Glass Lung', fields: { subkind: 'accessory' } }),
  );
  expect(r.ok).toBe(true);
  await expect(page().getByTestId('status-entities')).toHaveText('25 entities');
  await expect.poll(() => existsSync(file)).toBe(true);
  await page().locator('body').press('Control+z');
  await expect(page().getByTestId('status-entities')).toHaveText('24 entities');
  await expect.poll(() => existsSync(file)).toBe(false);
  await page().locator('body').press('Control+Shift+z');
  await expect(page().getByTestId('status-entities')).toHaveText('25 entities');
  const bad = await carbon.dispatch(
    cmd('relation.add', { from: 'glass-lung', type: 'made_from', to: 'hollows' }),
  );
  expect(bad).toMatchObject({ ok: false, error: { code: 'world.invalid' } });
});

test('@smoke the command palette runs actions', async () => {
  await page().locator('body').press('Control+k');
  await expect(page().getByTestId('palette')).toBeVisible();
  await page().keyboard.type('Go to Taste');
  await page().keyboard.press('Enter');
  await expect(page().getByTestId('view-taste')).toBeVisible();
  await expect(page().getByTestId('palette')).toHaveCount(0);
});

test('@smoke the fake AI answers over IPC and shows in the AI log', async () => {
  const out = await carbon.invoke('ai:run', {
    requestId: 't1',
    moment: 'critique',
    request: { entityId: 'glide', trigger: 'on_demand' },
  });
  expect(out.ok).toBe(true);
  await page().locator('body').press('Control+l');
  await expect(page().getByTestId('ai-log')).toContainText('critique');
  await carbon.screenshot('foundation-ai-log');
  await page().locator('body').press('Escape');
  await expect(page().getByTestId('ai-log')).toHaveCount(0);
  await page().locator('body').press('Control+Shift+a');
  await expect(page().getByTestId('status-ai')).toContainText('AI off');
});

const page = (): CarbonApp['page'] => carbon.page;
