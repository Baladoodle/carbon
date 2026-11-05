import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmd } from '@core/commands/registry';
import { sampleWorld } from '@core/testing/sample';
import { WorldSession } from '../world-session';
import { diskState, resetDiskState } from './disk-state';
import { WorldWatcher } from './watcher';
import { loadWorldDir, writeWorldDir } from './world-dir';

/**
 * Write failures (a full disk, a filesystem gone read-only, a permissions
 * change) simulated at the filesystem, below the atomic writer: creating the
 * temporary file of a failing path, or removing a failing path, throws
 * ENOSPC, as the real syscalls would. Every write path (one file, or a
 * transaction's batch) goes through these calls.
 */
const failing = new Set<string>();
const TMP = /^\.(.+)\.\d+\.\d+\.tmp$/;
const enospc = (file: string): Error =>
  Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), {
    code: 'ENOSPC',
  });
/** The file a path stands for: a temporary file stands for its target. */
const target = (p: unknown): string => {
  const s = String(p);
  const m = TMP.exec(path.basename(s));
  return m ? path.join(path.dirname(s), m[1] ?? '') : s;
};
const fails = (file: string): boolean => [...failing].some((f) => file.endsWith(f));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof FsPromises>();
  return {
    ...real,
    open: (async (p: Parameters<typeof real.open>[0], flags?: string, mode?: number) => {
      // Creating the new content fails; reading and the fsync reopen don't.
      if (flags === 'w' && TMP.test(path.basename(String(p))) && fails(target(p)))
        throw enospc(target(p));
      return real.open(p, flags, mode);
    }) as typeof real.open,
    rm: (async (p: Parameters<typeof real.rm>[0], opts?: Parameters<typeof real.rm>[1]) => {
      if (!TMP.test(path.basename(String(p))) && fails(String(p))) throw enospc(String(p));
      return real.rm(p, opts);
    }) as typeof real.rm,
  };
});

let dir: string;
const clock = (): string => '2026-11-05T01:00:00.000Z';
const GLIDE = 'entities/capability/glide.md';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-faults-'));
  failing.clear();
  await writeWorldDir(dir, sampleWorld());
  resetDiskState(dir);
});
afterEach(async () => {
  failing.clear();
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

async function reopened(): Promise<unknown> {
  resetDiskState(dir);
  return (await loadWorldDir(dir)).world;
}

describe('a write that fails', () => {
  it('stays unsaved until it lands, and says so', async () => {
    const s = await WorldSession.open(dir, clock);
    failing.add(GLIDE);
    s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'Lost?' } })]);
    await s.flush();
    expect(s.saveStatus().state).toBe('error');
    // A later save of another file succeeds, but glide is still not on disk:
    // the status must not claim "saved".
    s.dispatch([cmd('entity.update', { id: 'low-sky', set: { identity: 'Thin air.' } })]);
    await s.flush();
    expect(s.saveStatus().state).toBe('error');
    // The disk recovers; the next save writes what was left behind.
    failing.clear();
    s.dispatch([cmd('entity.update', { id: 'low-sky', set: { identity: 'Thinner air.' } })]);
    await s.flush();
    expect(s.saveStatus().state).toBe('saved');
    expect(await readFile(path.join(dir, GLIDE), 'utf8')).toContain('Lost?');
    expect(await reopened()).toEqual(s.world);
  });

  it('retrySave writes what was left behind without a new command', async () => {
    const s = await WorldSession.open(dir, clock);
    failing.add(GLIDE);
    s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'Retry me.' } })]);
    await s.flush();
    expect(s.saveStatus().state).toBe('error');
    expect(s.hasUnsaved()).toBe(true);
    failing.clear();
    s.retrySave();
    await s.flush();
    expect(s.saveStatus().state).toBe('saved');
    expect(s.hasUnsaved()).toBe(false);
    expect(await reopened()).toEqual(s.world);
  });

  it('a removal that fails is retried too', async () => {
    const s = await WorldSession.open(dir, clock);
    failing.add(GLIDE);
    s.dispatch([cmd('entity.delete', { id: 'glide' })]);
    await s.flush();
    expect(s.saveStatus().state).toBe('error');
    failing.clear();
    s.retrySave();
    await s.flush();
    expect(s.saveStatus().state).toBe('saved');
    expect(await reopened()).toEqual(s.world);
  });

  it('the watcher does not take the unchanged disk for an external edit that undoes it', async () => {
    const s = await WorldSession.open(dir, clock);
    const w = new WorldWatcher(dir, s);
    failing.add(GLIDE);
    s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'Keep me.' } })]);
    await s.flush();
    await w.scan();
    expect(s.world.entities.glide?.identity).toBe('Keep me.');
    expect(diskState(dir).unsaved.has(GLIDE)).toBe(true);
  });

  it('an external edit of a file that failed to save is merged, not overwritten', async () => {
    const s = await WorldSession.open(dir, clock);
    const w = new WorldWatcher(dir, s);
    failing.add(GLIDE);
    s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'Ours.' } })]);
    await s.flush();
    failing.clear();
    // Someone edits another field of the same file by hand.
    const text = await readFile(path.join(dir, GLIDE), 'utf8');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, GLIDE), text.replace(/^name: .*$/m, 'name: Glide Far'));
    await w.scan();
    expect(s.world.entities.glide?.identity).toBe('Ours.');
    expect(s.world.entities.glide?.name).toBe('Glide Far');
    s.retrySave();
    await s.flush();
    expect(await reopened()).toEqual(s.world);
  });

  it('one failing file in a transaction: the others land, it alone waits for the retry', async () => {
    const s = await WorldSession.open(dir, clock);
    const ids = Object.keys(s.world.entities);
    failing.add(GLIDE);
    s.dispatch(
      ids.map((id) => cmd('entity.update', { id, set: { identity: `Batch ${id}.` } })),
      'Everything at once',
    );
    await s.flush();
    expect(s.saveStatus().state).toBe('error');
    expect([...diskState(dir).unsaved.keys()]).toEqual([GLIDE]);
    for (const id of ids) {
      const file = path.join(dir, `entities/${s.world.entities[id]?.kind}/${id}.md`);
      const text = await readFile(file, 'utf8');
      if (id === 'glide') expect(text).not.toContain('Batch glide.');
      else expect(text).toContain(`Batch ${id}.`);
    }
    failing.clear();
    s.retrySave();
    await s.flush();
    expect(s.saveStatus().state).toBe('saved');
    expect(await reopened()).toEqual(s.world);
  });
});
