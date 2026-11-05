import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmd } from '@core/commands/registry';
import { sampleWorld } from '@core/testing/sample';
import { WorldSession } from '../world-session';
import { resetDiskState, diskState } from './disk-state';
import { META } from './meta';
import { loadWorldDir, writeWorldDir } from './world-dir';

/**
 * Opening a world that came from somewhere else: another OS, a hand edit, a
 * symlinked layout, a filesystem carbon can't write to.
 */
const fault = { erofs: false };
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof FsPromises>();
  const ro = (): never => {
    throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
  };
  return {
    ...real,
    mkdir: async (...a: Parameters<typeof real.mkdir>) => (fault.erofs ? ro() : real.mkdir(...a)),
    open: async (...a: Parameters<typeof real.open>) =>
      fault.erofs && a[1] !== 'r' ? ro() : real.open(...a),
    rm: async (...a: Parameters<typeof real.rm>) => (fault.erofs ? ro() : real.rm(...a)),
  };
});
import type * as FsPromises from 'node:fs/promises';

let dir: string;
const at = (): string => '2026-11-05T01:00:00.000Z';
const GLIDE = 'entities/capability/glide.md';

beforeEach(async () => {
  fault.erofs = false;
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-open-'));
  await writeWorldDir(dir, sampleWorld());
  resetDiskState(dir);
});
afterEach(async () => {
  fault.erofs = false;
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

const crlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

describe('files edited on another OS', () => {
  it('loads files with a byte-order mark instead of quarantining them', async () => {
    const settings = await readFile(path.join(dir, 'carbon.json'), 'utf8');
    const glide = await readFile(path.join(dir, GLIDE), 'utf8');
    await writeFile(path.join(dir, 'carbon.json'), `\uFEFF${settings}`);
    await writeFile(path.join(dir, GLIDE), `\uFEFF${glide}`);
    const r = await loadWorldDir(dir, { now: at });
    expect(r.issues).toEqual([]);
    expect(r.quarantined).toEqual([]);
    expect(r.world).toEqual(sampleWorld());
  });

  it('loads CRLF files exactly as their LF versions', async () => {
    for (const rel of [GLIDE, 'carbon.json', 'taste/rules.json', 'numbers/formulas.carbon']) {
      const p = path.join(dir, rel);
      await writeFile(p, crlf(await readFile(p, 'utf8')));
    }
    const r = await loadWorldDir(dir, { now: at });
    expect(r.issues).toEqual([]);
    expect(r.world).toEqual(sampleWorld());
  });

  it('a CRLF file is not an external edit, and carbon saves it with LF', async () => {
    const p = path.join(dir, GLIDE);
    await writeFile(p, crlf(await readFile(p, 'utf8')));
    const s = await WorldSession.open(dir, at);
    s.dispatch([cmd('entity.update', { id: 'glide', set: { description: 'One.\n\nTwo.' } })]);
    await s.flush();
    expect(await readFile(p, 'utf8')).not.toContain('\r');
    resetDiskState(dir);
    expect((await loadWorldDir(dir)).world).toEqual(s.world);
  });
});

describe('the layout on disk', () => {
  it('follows a symlinked kind directory', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'carbon-items-'));
    try {
      const items = path.join(dir, 'entities/item');
      await rm(elsewhere, { recursive: true });
      await rename(items, elsewhere);
      await symlink(elsewhere, items, 'dir');
      const r = await loadWorldDir(dir, { now: at });
      expect(r.issues).toEqual([]);
      expect(r.world).toEqual(sampleWorld());
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('reports an entity path it cannot read instead of dropping it silently', async () => {
    await mkdir(path.join(dir, 'entities/item/not-a-file.md'));
    const r = await loadWorldDir(dir, { now: at });
    expect(r.issues).toEqual([
      expect.objectContaining({ path: 'entities/item/not-a-file.md', code: 'file.unreadable' }),
    ]);
  });
});

describe('a broken schema.json or carbon.json', () => {
  it('opens read-only and moves nothing, instead of quarantining every entity that needs it', async () => {
    // Entities are validated against the schema: with the defaults in its
    // place, any entity using a custom option or range would be quarantined.
    await writeFile(path.join(dir, 'schema.json'), '{ "kinds": ');
    const before = (await readdir(path.join(dir, 'entities/item'))).sort();
    const r = await loadWorldDir(dir, { now: at });
    expect(r.quarantined).toEqual([]);
    expect(diskState(dir).readOnly).toMatch(/schema\.json/);
    expect((await readdir(path.join(dir, 'entities/item'))).sort()).toEqual(before);
    expect(await readFile(path.join(dir, 'schema.json'), 'utf8')).toBe('{ "kinds": ');
    expect(r.issues.map((i) => i.path)).toContain('schema.json');
  });

  it('the same for carbon.json', async () => {
    await writeFile(path.join(dir, 'carbon.json'), '{ "format": 2, ');
    const r = await loadWorldDir(dir, { now: at });
    expect(r.quarantined).toEqual([]);
    expect(diskState(dir).readOnly).toMatch(/carbon\.json/);
    expect(await readFile(path.join(dir, 'carbon.json'), 'utf8')).toBe('{ "format": 2, ');
  });

  it('a broken taste file is still quarantined and replaced by its default', async () => {
    await writeFile(path.join(dir, 'taste/rules.json'), '[');
    const r = await loadWorldDir(dir, { now: at });
    expect(r.quarantined).toHaveLength(1);
    expect(diskState(dir).readOnly).toBeNull();
  });
});

describe('a read-only filesystem', () => {
  it('opens the world read-only instead of failing to open', async () => {
    await rm(path.join(dir, 'ai-log'), { recursive: true, force: true }); // git doesn't keep empty dirs
    await writeFile(path.join(dir, 'taste/rules.json'), '['); // would be quarantined
    fault.erofs = true;
    const r = await loadWorldDir(dir, { now: at });
    expect(diskState(dir).readOnly).toMatch(/EROFS|read-only/);
    expect(Object.keys(r.world.entities).length).toBe(Object.keys(sampleWorld().entities).length);
    expect(r.quarantined).toEqual([]);
    fault.erofs = false;
    expect(await readFile(path.join(dir, 'taste/rules.json'), 'utf8')).toBe('[');
    await expect(readdir(path.join(dir, META.dir))).rejects.toThrow();
  });
});
