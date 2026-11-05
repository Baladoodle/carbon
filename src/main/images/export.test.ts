import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAiGateway } from '@core/ai/fake';
import { sampleWorld } from '@core/testing/sample';
import { resetDiskState } from '../store/disk-state';
import { writeExport } from '../store/exports';
import { writeWorldDir } from '../store/world-dir';
import { WorldSession } from '../world-session';
import { MainImageGateway } from './gateway';
import { decodePng } from './png';
import { FakeImageProvider } from './provider';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-image-export-'));
  await writeWorldDir(dir, sampleWorld());
});
afterEach(async () => {
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

const exists = (rel: string): Promise<boolean> =>
  stat(path.join(dir, rel)).then(
    () => true,
    () => false,
  );

describe('exporting images', () => {
  it('copies the selected icon and concept beside the spec, lists them, and undo/redo follow', async () => {
    const s = await WorldSession.open(dir);
    const decided = Object.values(s.world.entities).filter((e) => e.state === 'decided');
    const target = decided[0];
    if (!target) throw new Error('the sample has a decided entity');
    const g = new MainImageGateway({
      session: s,
      ai: new FakeAiGateway({ getWorld: () => s.world }),
      provider: new FakeImageProvider(),
      mode: 'fake',
    });
    const c = await g.generate({
      requestId: 'c',
      entityId: target.id,
      kind: 'concept',
      prompt: 'A concept of it, plainly',
    });
    const i = await g.iconFromConcept({ entityId: target.id });
    expect(c.ok && i.ok).toBe(true);
    const r = await writeExport(
      s,
      { name: 'First set', markdown: '# First set\n', entityIds: decided.map((e) => e.id) },
      '2026-11-05',
    );
    expect(r.ok).toBe(true);
    const icon = `exports/2026-11-05-first-set/images/${target.id}.icon.png`;
    const concept = `exports/2026-11-05-first-set/images/${target.id}.concept.png`;
    expect(decodePng(await readFile(path.join(dir, icon))).width).toBe(16);
    expect(await exists(concept)).toBe(true);
    const spec = await readFile(path.join(dir, 'exports/2026-11-05-first-set.md'), 'utf8');
    expect(spec).toContain('## Images');
    expect(spec).toContain(`\`${icon}\` (16×16)`);
    expect(spec).toContain(`\`${concept}\``);

    s.undo();
    await s.flush();
    expect(await exists(icon)).toBe(false);
    expect(await exists('exports/2026-11-05-first-set')).toBe(false);
    s.redo();
    await s.flush();
    expect(await exists(icon)).toBe(true);
  });

  it('a spec for entities without images has no Images section and no folder', async () => {
    const s = await WorldSession.open(dir);
    const ids = Object.values(s.world.entities)
      .filter((e) => e.state === 'decided')
      .map((e) => e.id);
    await writeExport(s, { name: 'Plain', markdown: '# Plain\n', entityIds: ids }, '2026-11-05');
    const spec = await readFile(path.join(dir, 'exports/2026-11-05-plain.md'), 'utf8');
    expect(spec).not.toContain('## Images');
    expect(await exists('exports/2026-11-05-plain')).toBe(false);
  });
});
