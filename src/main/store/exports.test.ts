import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readExportHeader } from '@core/export/spec';
import { sampleWorld } from '@core/testing/sample';
import { WorldSession } from '../world-session';
import { resetDiskState } from './disk-state';
import { Dismissals } from './dismissals';
import { listExports, localDate, writeExport } from './exports';
import { META } from './meta';
import { writeWorldDir } from './world-dir';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-export-'));
  await writeWorldDir(dir, sampleWorld());
});
afterEach(async () => {
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

const decided = (): string[] =>
  Object.values(sampleWorld().entities)
    .filter((e) => e.state === 'decided')
    .map((e) => e.id);

describe('writeExport', () => {
  it('writes the spec with its header and marks the entities exported, as one undo step', async () => {
    const s = await WorldSession.open(dir);
    const ids = decided();
    const r = await writeExport(
      s,
      { name: 'First set', markdown: '# First set\n\nBody.', entityIds: ids },
      '2026-11-04',
    );
    expect(r).toEqual({ ok: true, path: 'exports/2026-11-04-first-set.md', marked: ids.length });
    const text = await readFile(path.join(dir, 'exports/2026-11-04-first-set.md'), 'utf8');
    expect(readExportHeader(text)).toEqual({
      name: 'First set',
      date: '2026-11-04',
      entities: ids,
    });
    expect(text).toContain('# First set\n\nBody.\n');
    for (const id of ids) expect(s.world.entities[id]?.state).toBe('exported');
    expect(s.snapshot().history.undoLabel).toBe('Export First set');
    s.undo();
    for (const id of ids) expect(s.world.entities[id]?.state).toBe('decided');
    // The same name again gets its own file.
    const again = await writeExport(
      s,
      { name: 'First set', markdown: 'x', entityIds: ids },
      '2026-11-04',
    );
    expect(again).toMatchObject({ ok: true, path: 'exports/2026-11-04-first-set-2.md' });
    expect((await listExports(dir)).map((x) => x.path)).toEqual(
      ['exports/2026-11-04-first-set.md', 'exports/2026-11-04-first-set-2.md'].sort().reverse(),
    );
  });

  it('refuses entities that are missing or not decided, and writes nothing', async () => {
    const s = await WorldSession.open(dir);
    const idea = Object.values(s.world.entities).find((e) => e.state === 'idea');
    expect(await writeExport(s, { name: 'x', markdown: 'x', entityIds: ['nope'] })).toMatchObject({
      ok: false,
      error: { code: 'export.missing' },
    });
    expect(
      await writeExport(s, { name: 'x', markdown: 'x', entityIds: [idea?.id ?? ''] }),
    ).toMatchObject({ ok: false, error: { code: 'export.state' } });
    expect((await readdir(path.join(dir, 'exports'))).filter((n) => n.endsWith('.md'))).toEqual([]);
  });

  it('removes the file again if marking fails', async () => {
    const s = await WorldSession.open(dir);
    const failing = {
      dir: s.dir,
      world: s.world,
      flush: () => s.flush(),
      dispatch: () => ({ ok: false as const, error: { code: 'boom', message: 'boom' } }),
    };
    expect(
      await writeExport(failing, { name: 'x', markdown: 'x', entityIds: decided() }),
    ).toMatchObject({ ok: false, error: { code: 'boom' } });
    expect((await readdir(path.join(dir, 'exports'))).filter((n) => n.endsWith('.md'))).toEqual([]);
  });

  it('lists only files with carbon’s header', async () => {
    await writeFile(path.join(dir, 'exports/notes.md'), '# hand-written');
    expect(await listExports(dir)).toEqual([]);
  });

  it('local dates are YYYY-MM-DD', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('Dismissals', () => {
  it('persists, overwrites, clears, and survives a reopen', async () => {
    const d = new Dismissals(dir);
    expect(await d.all()).toEqual({});
    await d.set('check:a', 'h1');
    await d.set('check:b', 'h2');
    await d.set('check:a', 'h3');
    await d.set('check:b', null);
    expect(await new Dismissals(dir).all()).toEqual({ 'check:a': 'h3' });
    const raw = JSON.parse(await readFile(path.join(dir, META.dismissals), 'utf8')) as unknown;
    expect(raw).toEqual({ version: 1, notes: { 'check:a': 'h3' } });
  });

  it('starts empty from a broken file', async () => {
    const d0 = new Dismissals(dir);
    await d0.set('x', 'y');
    await writeFile(path.join(dir, META.dismissals), '{');
    expect(await new Dismissals(dir).all()).toEqual({});
  });
});
