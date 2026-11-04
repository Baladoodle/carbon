import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worldToFiles } from '@core/files/world-files';
import { emptyWorld } from '@core/model/world';
import { sampleWorld } from '@core/testing/sample';
import { writeFileAtomic } from './atomic';
import { loadWorldDir, readWorldFiles, writeChanges, writeWorldDir } from './world-dir';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('atomic writes', () => {
  it('writes through a temporary file and leaves no temporary files behind', async () => {
    const f = path.join(dir, 'a/b/c.txt');
    await writeFileAtomic(f, 'one');
    await writeFileAtomic(f, 'two');
    expect(await readFile(f, 'utf8')).toBe('two');
    expect(await readdir(path.join(dir, 'a/b'))).toEqual(['c.txt']);
  });

  it('cleans up when the rename fails', async () => {
    const target = path.join(dir, 'x');
    await writeFileAtomic(path.join(target, 'inner'), 'keep');
    await expect(writeFileAtomic(target, 'over a directory')).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('world directory', () => {
  it('initialises a new world with the full layout', async () => {
    const { world, issues } = await loadWorldDir(path.join(dir, 'new'));
    expect(issues).toEqual([]);
    expect(world).toEqual(emptyWorld());
    const top = (await readdir(path.join(dir, 'new'))).sort();
    expect(top).toEqual([
      'ai-log',
      'carbon.json',
      'entities',
      'exports',
      'numbers',
      'schema.json',
      'spreads',
      'taste',
    ]);
  });

  it('writes and reads back a world', async () => {
    await writeWorldDir(dir, sampleWorld());
    const { world, issues } = await loadWorldDir(dir);
    expect(issues).toEqual([]);
    expect(world).toEqual(sampleWorld());
  });

  it('reports a broken file and loads the rest', async () => {
    await writeWorldDir(dir, sampleWorld());
    await writeFile(path.join(dir, 'entities/item/spore-lantern.md'), 'garbage');
    await writeFile(path.join(dir, 'entities/item/.hidden.md'), 'ignored');
    const { world, issues } = await loadWorldDir(dir);
    expect(issues).toEqual([
      {
        path: 'entities/item/spore-lantern.md',
        code: 'file.frontmatter',
        message: expect.any(String) as string,
      },
    ]);
    expect(Object.keys(world.entities)).toHaveLength(
      Object.keys(sampleWorld().entities).length - 1,
    );
  });

  it('applies changes: writes and removals', async () => {
    await writeWorldDir(dir, sampleWorld());
    await writeChanges(dir, {
      write: new Map([['numbers/formulas.carbon', 'x = 2\n']]),
      remove: ['entities/feat/first-descent.md'],
    });
    const files = await readWorldFiles(dir);
    expect(files.get('numbers/formulas.carbon')).toBe('x = 2\n');
    expect(files.has('entities/feat/first-descent.md')).toBe(false);
  });
});

/**
 * The checked-in sample world must be exactly `sampleWorld()`.
 * Regenerate with `npm run fixtures:sample`.
 */
describe('fixtures/worlds/sample', () => {
  const fixture = path.resolve(__dirname, '../../../fixtures/worlds/sample');
  it('matches sampleWorld()', async () => {
    if (process.env.UPDATE_FIXTURES === '1') {
      await rm(fixture, { recursive: true, force: true });
      await writeWorldDir(fixture, sampleWorld());
      for (const d of ['exports', 'ai-log', 'spreads'])
        await writeFile(path.join(fixture, d, '.gitkeep'), '');
    }
    const files = await readWorldFiles(fixture);
    expect(new Map([...files].sort())).toEqual(new Map([...worldToFiles(sampleWorld())].sort()));
  });
});
