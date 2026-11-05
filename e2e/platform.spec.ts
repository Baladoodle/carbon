import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runChecks } from '@core/checks/runner';
import { cmd } from '@core/commands/registry';
import { entityFromMarkdown, entityToMarkdown } from '@core/files/entity-file';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * Package W6 (platform): the palette, checks and note dismissals, export,
 * external edits and conflicts, quarantine and git snapshots.
 */
let carbon: CarbonApp;
test.beforeAll(async () => {
  carbon = await launchCarbon();
});
test.afterAll(async () => {
  await carbon.close();
});
const page = (): CarbonApp['page'] => carbon.page;
const GLIDE = 'entities/capability/glide.md';

test('@smoke the palette ranks entities and actions fuzzily, by keyboard', async () => {
  await page().locator('body').press('Control+k');
  const palette = page().getByTestId('palette');
  await expect(palette).toBeVisible();
  await page().keyboard.type('glid');
  // The best match is highlighted first: the Glide capability.
  await expect(palette.locator('[data-highlighted]')).toContainText('Glide');
  await carbon.screenshot('platform-palette');
  await page().keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page().getByTestId('bench-entity').getByLabel('Name')).toHaveValue('Glide');

  // Arrows move, tab jumps between groups, escape closes.
  await page().locator('body').press('Control+k');
  await page().keyboard.type('go');
  const first = await palette.locator('[data-highlighted]').getAttribute('data-item');
  await page().keyboard.press('ArrowDown');
  expect(await palette.locator('[data-highlighted]').getAttribute('data-item')).not.toBe(first);
  await page().keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('@smoke mechanical checks show as notes, and a dismissal persists until its inputs change', async () => {
  const snap = await carbon.invoke('world:snapshot', null);
  const notes = runChecks(snap.world);
  expect(notes.length).toBeGreaterThan(0);
  const status = page().getByTestId('status-line');
  await expect(status).toContainText(`${notes.length} note`);
  // The checks run in a worker, off the renderer's main thread.
  expect(
    page()
      .workers()
      .some((w) => /checks\.worker/.test(w.url())),
  ).toBe(true);

  // Dismiss one the way the margin does (persisted with its inputs hash), then reload the renderer.
  const n = notes.find((x) => x.id === 'check:material-nowhere:sky-coral');
  if (!n) throw new Error('sample changed');
  await carbon.invoke('notes:setDismissal', { id: n.id, hash: n.inputsHash ?? '' });
  await page().reload();
  await page().waitForSelector('[data-testid="status-entities"]');
  await expect(status).toContainText(`${notes.length - 1} note`);
  const file = JSON.parse(
    readFileSync(path.join(carbon.worldDir, '.carbon/dismissals.json'), 'utf8'),
  ) as {
    notes: Record<string, string>;
  };
  expect(file.notes[n.id]).toBe(n.inputsHash);

  // An unrelated edit keeps it dismissed …
  await carbon.dispatch(cmd('entity.update', { id: 'glide', set: { description: 'Unrelated.' } }));
  await expect(status).toContainText(`${notes.length - 1} note`);
  // … giving the material a place resolves it; the other notes stay.
  await carbon.dispatch(
    cmd('relation.add', { from: 'sky-coral', type: 'found_in', to: 'low-sky' }),
  );
  const after = runChecks((await carbon.invoke('world:snapshot', null)).world).length;
  await expect(status).toContainText(`${after} note`);
});

test('export: choose by kind, draft with the AI, edit, write and mark exported', async () => {
  await carbon.gotoView('export', '7');
  await page().getByTestId('export-kind-band').click();
  await expect(page().getByTestId('export-count')).not.toHaveText('0 entities');
  await page().getByTestId('export-draft').click();
  const editor = page().getByTestId('export-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('data-ai', '');
  await carbon.screenshot('platform-export');
  // Editing it removes the AI marker.
  await editor.press('Control+End');
  await editor.pressSequentially('\nEdited by hand.');
  await expect(editor).not.toHaveAttribute('data-ai', '');
  await editor.press('Control+s');
  await expect(editor).toHaveCount(0);

  const files = readdirSync(path.join(carbon.worldDir, 'exports')).filter((f) => f.endsWith('.md'));
  expect(files).toHaveLength(1);
  const text = readFileSync(path.join(carbon.worldDir, 'exports', files[0] ?? ''), 'utf8');
  expect(text).toMatch(/^---\ncarbon_export: 1\n/);
  expect(text).toContain('Edited by hand.');
  const snap = await carbon.invoke('world:snapshot', null);
  const bands = Object.values(snap.world.entities).filter(
    (e) => e.kind === 'band' && (e.state === 'decided' || e.state === 'exported'),
  );
  for (const b of bands) expect(b.state).toBe('exported');
  // One undo step reverts the marking and takes the spec file away; redo puts both back.
  expect(snap.history.undoLabel).toMatch(/^Export /);
  const exportsDir = path.join(carbon.worldDir, 'exports');
  const specs = (): string[] => readdirSync(exportsDir).filter((f) => f.endsWith('.md'));
  await page().locator('body').press('Control+z');
  await expect.poll(specs).toEqual([]);
  await page().locator('body').press('Control+Shift+z');
  await expect.poll(specs).toEqual(files);
  expect(readFileSync(path.join(exportsDir, files[0] ?? ''), 'utf8')).toBe(text);
  const redone = await carbon.invoke('world:snapshot', null);
  for (const b of bands) expect(redone.world.entities[b.id]?.state).toBe('exported');
});

test('the export choice is reachable from the palette: every kind and band', async () => {
  await carbon.gotoView('export', '7');
  const chip = page().getByTestId('export-band-low-sky');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await page().locator('body').press('Control+k');
  await page().keyboard.type('choose by band low sky');
  await expect(page().getByTestId('palette').locator('[data-highlighted]')).toContainText(
    'Low Sky',
  );
  await page().keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await page().locator('body').press('Control+k');
  await page().keyboard.type('clear the export choice');
  await page().keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
});

test('external edits flow in; a clash with an unsaved edit asks which to keep', async () => {
  const file = path.join(carbon.worldDir, GLIDE);
  // A plain external edit: taken as is.
  const r0 = entityFromMarkdown(readFileSync(file, 'utf8'));
  if (!r0.ok) throw new Error(r0.error.message);
  writeFileSync(file, entityToMarkdown({ ...r0.value, identity: 'Edited in vim.' }));
  await expect
    .poll(async () => (await carbon.invoke('world:snapshot', null)).world.entities.glide?.identity)
    .toBe('Edited in vim.');

  // Carbon edits identity; within the settle window the outside writes its own, from the old file.
  const before = readFileSync(file, 'utf8');
  await carbon.dispatch(cmd('entity.update', { id: 'glide', set: { identity: 'From carbon.' } }));
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('From carbon.');
  const r = entityFromMarkdown(before);
  if (!r.ok) throw new Error(r.error.message);
  writeFileSync(file, entityToMarkdown({ ...r.value, identity: 'From Claude Code.' }));
  const dialog = page().getByTestId('conflicts');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('From carbon.');
  await expect(dialog).toContainText('From Claude Code.');
  await carbon.screenshot('platform-conflict');
  await page().getByTestId('conflict-theirs').click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await carbon.invoke('world:snapshot', null)).world.entities.glide?.identity)
    .toBe('From Claude Code.');
  expect(readFileSync(file, 'utf8')).toContain('From Claude Code.');
});

test('a manual snapshot commits the world with a generated message', async () => {
  const r = await carbon.invoke('store:snapshotNow', null);
  expect(r.status).toBe('committed');
  const log = execFileSync('git', ['log', '-1', '--format=%B'], {
    cwd: carbon.worldDir,
    encoding: 'utf8',
  });
  expect(log).toContain('carbon snapshot (manual)');
  expect(await carbon.invoke('store:snapshotNow', null)).toEqual({ status: 'clean' });
});

test('invalid files are quarantined and reported in the status line', async () => {
  const broken = await launchCarbon({ world: 'broken' });
  try {
    const issues = broken.page.getByTestId('status-issues');
    await expect(issues).toContainText('2 unreadable files');
    const q = path.join(broken.worldDir, '.carbon/quarantine');
    const [stampDir] = readdirSync(q);
    expect(existsSync(path.join(q, stampDir ?? '', 'entities/item/torn-cloak.md'))).toBe(true);
    expect(existsSync(path.join(broken.worldDir, 'entities/item/torn-cloak.md'))).toBe(false);
    // The palette offers the folder.
    await broken.page.locator('body').press('Control+k');
    await broken.page.keyboard.type('quarantine');
    await expect(broken.page.getByTestId('palette')).toContainText('Open the quarantine folder');
    await broken.page.keyboard.press('Escape');
    await broken.screenshot('platform-quarantine');
  } finally {
    await broken.close();
  }
});

test('the export view’s empty state', async () => {
  const empty = await launchCarbon({ world: null });
  try {
    await empty.gotoView('export', '7');
    await expect(empty.page.getByTestId('export-empty')).toBeVisible();
  } finally {
    await empty.close();
  }
});
