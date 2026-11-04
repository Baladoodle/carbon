import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPatch } from '@core/commands/patch';
import { cmd } from '@core/commands/registry';
import { sampleWorld } from '@core/testing/sample';
import type { PatchEvent, SaveStatus } from '@shared/ipc';
import { PatchEventSchema, WorldSnapshotSchema } from '@shared/ipc';
import { writeWorldDir } from './store/world-dir';
import { WorldSession } from './world-session';

let dir: string;
const clock = (): string => '2026-11-04T10:00:00.000Z';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-session-'));
  await writeWorldDir(dir, sampleWorld());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('WorldSession', () => {
  it('dispatches, persists only touched files, and emits numbered patches a mirror can apply', async () => {
    const s = await WorldSession.open(dir, clock);
    const snap = WorldSnapshotSchema.parse(s.snapshot());
    let mirror = snap.world;
    const events: PatchEvent[] = [];
    const saves: SaveStatus['state'][] = [];
    s.onPatch((e) => {
      events.push(PatchEventSchema.parse(e));
      mirror = applyPatch(mirror, e.patch);
    });
    s.onSaveStatus((x) => saves.push(x.state));

    const r = s.dispatch([
      cmd('entity.create', { kind: 'material', name: 'Ash Pearl' }),
      cmd('relation.add', { from: 'ash-pearl', type: 'found_in', to: 'ash-vents' }),
    ]);
    expect(r).toEqual({ ok: true, rev: 1 });
    expect(events[0]).toMatchObject({
      rev: 1,
      cause: 'command',
      label: 'Create Ash Pearl (+1)',
      history: { canUndo: true, canRedo: false },
    });
    expect(mirror).toEqual(s.world);
    await s.flush();
    expect(saves).toEqual(['saving', 'saved']);
    expect(await readFile(path.join(dir, 'entities/material/ash-pearl.md'), 'utf8')).toContain(
      'target: ash-vents',
    );

    expect(s.undo()).toEqual({ ok: true, rev: 2, label: 'Create Ash Pearl (+1)' });
    await s.flush();
    expect(await exists(path.join(dir, 'entities/material/ash-pearl.md'))).toBe(false);
    expect(s.world).toEqual(sampleWorld());
    expect(s.redo()).toMatchObject({ ok: true, rev: 3 });
    expect(mirror).toEqual(s.world);
    expect(s.snapshot().history).toEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: 'Create Ash Pearl (+1)',
    });
    await s.flush();
    const reopened = await WorldSession.open(dir, clock);
    expect(reopened.world).toEqual(s.world);
  });

  it('refuses invalid commands without changing anything', async () => {
    const s = await WorldSession.open(dir, clock);
    const r = s.dispatch([cmd('entity.delete', { id: 'ghost' })]);
    expect(r).toMatchObject({ ok: false, error: { code: 'entity.not_found' } });
    expect(s.snapshot().rev).toBe(0);
    expect(s.undo()).toMatchObject({ ok: false, error: { code: 'history.nothing_to_undo' } });
    expect(s.redo()).toMatchObject({ ok: false, error: { code: 'history.nothing_to_redo' } });
  });

  it('reports a failed save', async () => {
    const s = await WorldSession.open(dir, clock);
    await rm(dir, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.writeFile(dir, 'now a file'));
    s.dispatch([cmd('numbers.setFormulas', { source: 'x = 1' })]);
    await s.flush();
    expect(s.saveStatus().state).toBe('error');
    await rm(dir, { force: true });
  });
});
