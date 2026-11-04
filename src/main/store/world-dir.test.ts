import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entityFromMarkdown, entityToMarkdown } from '@core/files/entity-file';
import { PATHS, worldToFiles, type FileMap } from '@core/files/world-files';
import { emptyWorld } from '@core/model/world';
import { sampleWorld } from '@core/testing/sample';
import { writeFileAtomic } from './atomic';
import { diskState, resetDiskState } from './disk-state';
import { META } from './meta';
import { formatOf, migrateFiles, planMigrations, withFormat, type Migration } from './migrations';
import { recoverMigration } from './migrate';
import { loadWorldDir, readWorldFiles, writeChanges, writeWorldDir } from './world-dir';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-store-'));
});
afterEach(async () => {
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

const at = (): string => '2026-11-04T10:00:00.000Z';

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

  it('removes temporary files a crash left behind when it opens', async () => {
    await writeWorldDir(dir, sampleWorld());
    await writeFile(path.join(dir, 'entities/item/.glide.md.4242.7.tmp'), 'half a fi');
    const r = await loadWorldDir(dir);
    expect(r.cleaned).toEqual(['entities/item/.glide.md.4242.7.tmp']);
    expect(r.issues).toEqual([]);
  });

  it('records reads and writes for the watcher', async () => {
    await writeWorldDir(dir, sampleWorld());
    await loadWorldDir(dir);
    const s = diskState(dir);
    expect(s.known.get(PATHS.formulas)).toBe(sampleWorld().numbers.formulas);
    await writeChanges(dir, { write: new Map([[PATHS.formulas, 'y = 1\n']]), remove: [] });
    expect(s.known.get(PATHS.formulas)).toBe('y = 1\n');
    expect(s.base.get(PATHS.formulas)).toBe(sampleWorld().numbers.formulas);
  });
});

describe('quarantine', () => {
  it('moves an invalid entity file aside, reports it and loads the rest', async () => {
    await writeWorldDir(dir, sampleWorld());
    await writeFile(path.join(dir, 'entities/item/spore-lantern.md'), 'garbage');
    await writeFile(path.join(dir, 'entities/item/.hidden.md'), 'ignored');
    const r = await loadWorldDir(dir, { now: at });
    const dest = `${META.quarantine}/2026-11-04T10-00-00-000Z/entities/item/spore-lantern.md`;
    expect(r.issues).toEqual([
      {
        path: 'entities/item/spore-lantern.md',
        code: 'file.frontmatter',
        message: expect.stringContaining(`(moved to ${dest})`) as string,
      },
    ]);
    expect(r.quarantined).toEqual([dest]);
    expect(await readFile(path.join(dir, dest), 'utf8')).toBe('garbage');
    expect(await readdir(path.join(dir, 'entities/item'))).not.toContain('spore-lantern.md');
    expect(Object.keys(r.world.entities)).toHaveLength(
      Object.keys(sampleWorld().entities).length - 1,
    );
    // Backups and quarantine stay out of the world's git history.
    expect(await readFile(path.join(dir, META.gitignore), 'utf8')).toContain('quarantine/');
    // The next open is clean: nothing is quarantined twice.
    const again = await loadWorldDir(dir, { now: at });
    expect(again.issues).toEqual([]);
  });

  it('quarantines each kind of bad file', async () => {
    await writeWorldDir(dir, sampleWorld());
    const glide = await readFile(path.join(dir, 'entities/capability/glide.md'), 'utf8');
    await writeFile(path.join(dir, 'entities/item/wrong-place.md'), glide); // file.location
    await writeFile(path.join(dir, 'entities/band/bad-yaml.md'), '---\na: [\n---\n'); // file.yaml
    await writeFile(path.join(dir, 'spreads/broken.json'), '{'); // file.json
    await writeFile(path.join(dir, 'taste/rules.json'), '[{"nope":1}]'); // file.invalid
    const r = await loadWorldDir(dir, { now: at });
    expect(r.issues.map((i) => [i.path, i.code]).sort()).toEqual(
      [
        ['entities/band/bad-yaml.md', 'file.yaml'],
        ['entities/item/wrong-place.md', 'file.location'],
        ['spreads/broken.json', 'file.json'],
        ['taste/rules.json', 'file.invalid'],
      ].sort(),
    );
    expect(r.quarantined).toHaveLength(4);
    // A quarantined root file is replaced by its default, so the world stays complete.
    expect(JSON.parse(await readFile(path.join(dir, 'taste/rules.json'), 'utf8'))).toEqual([]);
    expect(r.world.entities.glide).toBeDefined();
  });

  it('quarantines the second file of a duplicated id', async () => {
    await writeWorldDir(dir, sampleWorld());
    const e = sampleWorld().entities.glide;
    if (!e) throw new Error('sample changed');
    // Same id under another kind's folder: file.location; same folder twice is impossible, so use kind mismatch.
    await mkdir(path.join(dir, 'entities/item'), { recursive: true });
    await writeFile(
      path.join(dir, 'entities/item/glide.md'),
      entityToMarkdown({ ...e, kind: 'item', fields: { subkind: 'tool' } }),
    );
    const r = await loadWorldDir(dir, { now: at });
    expect(r.issues.map((i) => i.code)).toEqual(['file.duplicate_id']);
    expect(r.world.entities.glide?.kind).toBe('capability');
  });
});

// ── Migrations ──────────────────────────────────────────────────────────────

/** Test migrations: 1→2 tags every entity, 2→3 adds a header to the formulas. */
const TAG = 'migrated-v2';
const mapEntities = (files: FileMap, f: (text: string) => string): FileMap =>
  new Map([...files].map(([p, c]) => [p, p.startsWith('entities/') ? f(c) : c]));
const retag =
  (add: boolean) =>
  (text: string): string => {
    const r = entityFromMarkdown(text);
    if (!r.ok) return text;
    const tags = add ? [...r.value.tags, TAG] : r.value.tags.filter((t) => t !== TAG);
    return entityToMarkdown({ ...r.value, tags });
  };
const HEADER = '# format 3\n';
const TEST_MIGRATIONS: Migration[] = [
  {
    from: 1,
    to: 2,
    describe: 'tag every entity',
    up: (f) => mapEntities(f, retag(true)),
    down: (f) => mapEntities(f, retag(false)),
  },
  {
    from: 2,
    to: 3,
    describe: 'header in formulas',
    up: (f) => new Map(f).set(PATHS.formulas, HEADER + (f.get(PATHS.formulas) ?? '')),
    down: (f) => {
      const t = f.get(PATHS.formulas) ?? '';
      return new Map(f).set(PATHS.formulas, t.startsWith(HEADER) ? t.slice(HEADER.length) : t);
    },
  },
];

describe('migrations (pure)', () => {
  const files = worldToFiles(sampleWorld());

  it('reads the format, defaulting to 1', () => {
    expect(formatOf(files)).toBe(1);
    expect(formatOf(new Map())).toBe(1);
    expect(formatOf(new Map([[PATHS.settings, '{']]))).toBe(1);
    expect(formatOf(withFormat(files, 7))).toBe(7);
  });

  it('plans chains up and down, and refuses gaps', () => {
    expect(planMigrations(1, 3, TEST_MIGRATIONS)).toMatchObject({
      ok: true,
      steps: [{ from: 1 }, { from: 2 }],
    });
    expect(planMigrations(3, 1, TEST_MIGRATIONS)).toMatchObject({
      ok: true,
      steps: [{ from: 2 }, { from: 1 }],
    });
    expect(planMigrations(1, 4, TEST_MIGRATIONS)).toMatchObject({ ok: false });
    expect(planMigrations(2, 2, TEST_MIGRATIONS)).toEqual({ ok: true, steps: [] });
    expect(
      planMigrations(2, 1, [{ ...TEST_MIGRATIONS[0], down: undefined } as Migration]),
    ).toMatchObject({ ok: false });
  });

  it('migrates up and back down to exactly the same files', () => {
    const up = migrateFiles(files, 1, 3, TEST_MIGRATIONS);
    if (!up.ok) throw new Error(up.message);
    expect(formatOf(up.files)).toBe(3);
    expect(up.files.get(PATHS.formulas)?.startsWith(HEADER)).toBe(true);
    const down = migrateFiles(up.files, 3, 1, TEST_MIGRATIONS);
    if (!down.ok) throw new Error(down.message);
    expect(new Map([...down.files].sort())).toEqual(new Map([...withFormat(files, 1)].sort()));
  });

  it('property: down(up(x)) = x for any formulas text and settings name', () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (formulas, name) => {
        fc.pre(!formulas.startsWith(HEADER));
        const w = sampleWorld();
        w.numbers.formulas = formulas;
        w.settings.name = name;
        const f = worldToFiles(w);
        const up = migrateFiles(f, 1, 3, TEST_MIGRATIONS);
        if (!up.ok) return false;
        const down = migrateFiles(up.files, 3, 1, TEST_MIGRATIONS);
        return down.ok && [...f].every(([p, c]) => down.files.get(p) === c);
      }),
      { numRuns: 50 },
    );
  });

  it('every shipped migration with a down round-trips the sample world', async () => {
    const { MIGRATIONS } = await import('./migrations');
    for (const m of MIGRATIONS) {
      if (!m.down) continue;
      const f = withFormat(files, m.from);
      expect(m.down(m.up(f))).toEqual(f);
    }
  });
});

describe('migrations on disk', () => {
  it('backs up, migrates, and opens the migrated world', async () => {
    await writeWorldDir(dir, sampleWorld());
    const before = await readWorldFiles(dir);
    const r = await loadWorldDir(dir, { now: at, migrations: TEST_MIGRATIONS, format: 3 });
    expect(r.issues).toEqual([]);
    expect(r.migrated).toEqual({
      from: 1,
      to: 3,
      backup: `${META.backups}/2026-11-04T10-00-00-000Z-format-1`,
    });
    expect(r.world.settings.format).toBe(3);
    expect(r.world.entities.glide?.tags).toContain(TAG);
    // The backup is the world exactly as it was, with a manifest.
    const backup = path.join(dir, r.migrated?.backup ?? '');
    for (const [rel, content] of before)
      expect(await readFile(path.join(backup, rel), 'utf8')).toBe(content);
    const manifest = JSON.parse(await readFile(path.join(backup, 'manifest.json'), 'utf8')) as {
      migrations: string[];
    };
    expect(manifest.migrations).toEqual(['tag every entity', 'header in formulas']);
    // The marker is gone, and a second open does nothing more.
    expect(await readdir(path.join(dir, META.dir))).not.toContain('migration.json');
    const again = await loadWorldDir(dir, { now: at, migrations: TEST_MIGRATIONS, format: 3 });
    expect(again.migrated).toBeUndefined();
    expect(again.world).toEqual(r.world);
  });

  it('recovers from a crash at every point of a migration', async () => {
    // A clean migration, for reference.
    await writeWorldDir(dir, sampleWorld());
    const clean = await loadWorldDir(dir, { now: at, migrations: TEST_MIGRATIONS, format: 3 });
    const cleanFiles = await readWorldFiles(dir);
    const total = [...cleanFiles].filter(
      ([p, c]) => worldToFiles(sampleWorld()).get(p) !== c,
    ).length;
    expect(total).toBeGreaterThan(3);

    for (let crashAt = 0; crashAt < total; crashAt++) {
      const d = await mkdtemp(path.join(os.tmpdir(), 'carbon-mig-'));
      await writeWorldDir(d, sampleWorld());
      await expect(
        loadWorldDir(d, {
          now: at,
          migrations: TEST_MIGRATIONS,
          format: 3,
          crashAfterWrites: crashAt,
        }),
      ).rejects.toThrow('simulated crash');
      // carbon.json is written last, so a crashed world still says format 1 …
      expect(formatOf(await readWorldFiles(d))).toBe(1);
      // … and the next open restores the backup and migrates again, cleanly.
      const r = await loadWorldDir(d, { now: at, migrations: TEST_MIGRATIONS, format: 3 });
      expect(r.world).toEqual(clean.world);
      expect(new Map([...(await readWorldFiles(d))].sort())).toEqual(
        new Map([...cleanFiles].sort()),
      );
      resetDiskState(d);
      await rm(d, { recursive: true, force: true });
    }
  });

  it('recoverMigration restores files exactly and removes ones the migration added', async () => {
    await writeWorldDir(dir, sampleWorld());
    const before = await readWorldFiles(dir);
    const backup = `${META.backups}/x-format-1`;
    for (const [rel, c] of before) await writeFileAtomic(path.join(dir, backup, rel), c);
    await writeFileAtomic(
      path.join(dir, backup, 'manifest.json'),
      JSON.stringify({
        from: 1,
        to: 2,
        at: 'x',
        files: [...before.keys(), '../escape'],
        migrations: [],
      }),
    );
    await writeFileAtomic(
      path.join(dir, META.migration),
      JSON.stringify({ from: 1, to: 2, backup }),
    );
    await writeFile(path.join(dir, PATHS.formulas), 'half-migrated');
    await writeFile(path.join(dir, 'spreads/new-one.json'), '{"id":"new-one","created":"x"}');
    expect(await recoverMigration(dir, readWorldFiles)).toBe(true);
    expect(new Map([...(await readWorldFiles(dir))].sort())).toEqual(new Map([...before].sort()));
    expect(await recoverMigration(dir, readWorldFiles)).toBe(false);
  });

  it('ignores a damaged marker without touching the files', async () => {
    await writeWorldDir(dir, sampleWorld());
    const before = await readWorldFiles(dir);
    await writeFileAtomic(path.join(dir, META.migration), JSON.stringify({ backup: '/etc' }));
    expect(await recoverMigration(dir, readWorldFiles)).toBe(false);
    expect(await readWorldFiles(dir)).toEqual(before);
  });

  it('opens a world from a newer carbon read-only and never quarantines its files', async () => {
    const w = sampleWorld();
    w.settings.format = 9;
    await writeWorldDir(dir, w);
    await writeFile(path.join(dir, 'entities/item/odd.md'), 'a format-9 file we cannot read');
    const r = await loadWorldDir(dir, { now: at });
    expect(r.issues.map((i) => i.code).sort()).toEqual(['file.frontmatter', 'format.newer']);
    expect(r.quarantined).toEqual([]);
    expect(diskState(dir).readOnly).toMatch(/newer/);
    await expect(
      writeChanges(dir, { write: new Map([[PATHS.formulas, 'x']]), remove: [] }),
    ).rejects.toThrow(/newer/);
  });

  it('opens read-only when no migration path exists', async () => {
    await writeWorldDir(dir, sampleWorld());
    const r = await loadWorldDir(dir, { now: at, migrations: [], format: 2 });
    expect(r.issues.map((i) => i.code)).toEqual(['format.migration']);
    expect(diskState(dir).readOnly).toMatch(/no migration/);
  });
});

/**
 * The checked-in sample world must be exactly `sampleWorld()`.
 * Regenerate with `npm run fixtures:sample`.
 */
describe('fixtures/worlds/sample', () => {
  const fixture = path.resolve(import.meta.dirname, '../../../fixtures/worlds/sample');
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
