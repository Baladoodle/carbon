import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmd } from '@core/commands/registry';
import { entityFromMarkdown, entityToMarkdown } from '@core/files/entity-file';
import { worldFromFiles, worldToFiles } from '@core/files/world-files';
import { sampleWorld } from '@core/testing/sample';
import type { Entity } from '@core/model/entity';
import type { PatchEvent } from '@shared/ipc';
import { WorldSession } from '../world-session';
import { applyFileChanges } from './apply-files';
import { diskState, resetDiskState } from './disk-state';
import { mergeFile } from './merge';
import { ignoredPath, WorldWatcher, type Conflict } from './watcher';
import { writeWorldDir } from './world-dir';

let dir: string;
let t = 1_000_000;
const clock = (): string => '2026-11-04T10:00:00.000Z';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-watch-'));
  await writeWorldDir(dir, sampleWorld());
  t = 1_000_000;
});
afterEach(async () => {
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

async function open(): Promise<{
  s: WorldSession;
  w: WorldWatcher;
  conflicts: Conflict[][];
  events: PatchEvent[];
}> {
  const s = await WorldSession.open(dir, clock);
  const disk = diskState(dir);
  disk.now = () => t;
  disk.settleMs = 15_000;
  const conflicts: Conflict[][] = [];
  const events: PatchEvent[] = [];
  s.onPatch((e) => events.push(e));
  const w = new WorldWatcher(dir, s, { onConflicts: (c) => conflicts.push(c) });
  return { s, w, conflicts, events };
}

const file = (rel: string): string => path.join(dir, rel);
const GLIDE = 'entities/capability/glide.md';

async function editFile(rel: string, f: (e: Entity) => Entity): Promise<void> {
  const r = entityFromMarkdown(await readFile(file(rel), 'utf8'));
  if (!r.ok) throw new Error(r.error.message);
  await writeFile(file(rel), entityToMarkdown(f(r.value)));
}

describe('WorldWatcher', () => {
  it('ignores carbon’s own writes', async () => {
    const { s, w, events } = await open();
    s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'Ride the updraft.' } })]);
    await s.flush();
    const before = events.length;
    await w.scan();
    expect(events.length).toBe(before);
  });

  it('a command saved while a scan reads is carbon’s own write, not an external edit', async () => {
    const { s, conflicts, events } = await open();
    // An earlier edit opens the settle window (its base is the original file).
    s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'First.' } })]);
    await s.flush();
    // A session whose second flush (the scan's re-read) lets a new command in
    // and doesn't wait for its save: the save records its write, then lands
    // while the scan is reading.
    let calls = 0;
    const racing = {
      get world() {
        return s.world;
      },
      flush: (): Promise<void> => {
        calls++;
        if (calls === 2)
          s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'Second.' } })]);
        return calls === 2 ? Promise.resolve() : s.flush();
      },
      applyExternal: (next: Parameters<WorldSession['applyExternal']>[0]) => s.applyExternal(next),
    };
    const w = new WorldWatcher(dir, racing, { onConflicts: (c) => conflicts.push(c) });
    const before = events.length;
    await w.scan();
    await s.flush();
    await w.scan();
    expect(conflicts).toEqual([]);
    expect(events.length).toBe(before + 1); // the second command's own patch, nothing external
    expect(s.world.entities['glide']?.identity).toBe('Second.');
    expect(await readFile(file(GLIDE), 'utf8')).toContain('identity: Second.');
    expect(diskState(dir).known.get(GLIDE)).toBe(await readFile(file(GLIDE), 'utf8'));
  });

  it('takes an external edit of a file carbon hasn’t touched, as an external patch', async () => {
    const { s, w, events, conflicts } = await open();
    await editFile(GLIDE, (e) => ({ ...e, identity: 'Edited by hand.' }));
    await w.scan();
    expect(s.world.entities.glide?.identity).toBe('Edited by hand.');
    expect(events.at(-1)).toMatchObject({ cause: 'external' });
    expect(conflicts).toEqual([]);
  });

  it('picks up new and removed files', async () => {
    const { s, w } = await open();
    const glide = s.world.entities.glide as Entity;
    await writeFile(
      file('entities/capability/hover.md'),
      entityToMarkdown({ ...glide, id: 'hover', name: 'Hover', relations: [] }),
    );
    await unlink(file('entities/feat/first-descent.md'));
    await w.scan();
    expect(s.world.entities.hover?.name).toBe('Hover');
    expect(s.world.entities['first-descent']).toBeUndefined();
  });

  it('merges an external edit with carbon’s unsaved edit of other fields, and writes the merge back', async () => {
    const { s, w, conflicts } = await open();
    const before = await readFile(file(GLIDE), 'utf8');
    s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'From carbon.' } })]);
    await s.flush();
    t += 2000; // inside the settle window
    // The outside writes a version based on the file before carbon's edit.
    const r = entityFromMarkdown(before);
    if (!r.ok) throw new Error();
    await writeFile(file(GLIDE), entityToMarkdown({ ...r.value, why: 'From the file.' }));
    await w.scan();
    expect(conflicts).toEqual([]);
    expect(s.world.entities.glide).toMatchObject({
      identity: 'From carbon.',
      why: 'From the file.',
    });
    const onDisk = entityFromMarkdown(await readFile(file(GLIDE), 'utf8'));
    expect(onDisk.ok && onDisk.value).toMatchObject({
      identity: 'From carbon.',
      why: 'From the file.',
    });
  });

  it('asks which to keep when both changed the same field, and applies the choice', async () => {
    for (const keep of ['ours', 'theirs'] as const) {
      resetDiskState(dir);
      await writeWorldDir(dir, sampleWorld());
      const { s, w, conflicts } = await open();
      const before = await readFile(file(GLIDE), 'utf8');
      s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'From carbon.' } })]);
      await s.flush();
      t += 1000;
      const r = entityFromMarkdown(before);
      if (!r.ok) throw new Error();
      await writeFile(
        file(GLIDE),
        entityToMarkdown({ ...r.value, identity: 'From the file.', why: 'Also the file.' }),
      );
      await w.scan();
      expect(conflicts).toHaveLength(1);
      const c = conflicts[0]?.[0];
      expect(c).toMatchObject({
        path: GLIDE,
        entity: { id: 'glide', name: 'Glide' },
        fields: [{ key: 'identity', ours: 'From carbon.', theirs: 'From the file.' }],
      });
      // Until the user decides: carbon's value on the conflict, the file's elsewhere.
      expect(s.world.entities.glide).toMatchObject({
        identity: 'From carbon.',
        why: 'Also the file.',
      });
      expect(await w.resolve(c?.id ?? '', keep)).toBe(true);
      const want = keep === 'ours' ? 'From carbon.' : 'From the file.';
      expect(s.world.entities.glide).toMatchObject({ identity: want, why: 'Also the file.' });
      const onDisk = entityFromMarkdown(await readFile(file(GLIDE), 'utf8'));
      expect(onDisk.ok && onDisk.value.identity).toBe(want);
      expect(w.conflicts()).toEqual([]);
      expect(await w.resolve(c?.id ?? '', keep)).toBe(false);
      // Settled: scanning again changes nothing.
      const snap = s.world;
      await w.scan();
      expect(s.world).toBe(snap);
    }
  });

  it('after the settle window, an external edit simply wins (no false conflicts)', async () => {
    const { s, w, conflicts } = await open();
    s.dispatch([cmd('entity.update', { id: 'glide', set: { identity: 'From carbon.' } })]);
    await s.flush();
    t += 60_000;
    await editFile(GLIDE, (e) => ({ ...e, identity: 'Later, by hand.' }));
    await w.scan();
    expect(conflicts).toEqual([]);
    expect(s.world.entities.glide?.identity).toBe('Later, by hand.');
  });

  it('keeps carbon’s version of an invalid external edit and reports it once', async () => {
    const { s, w, events } = await open();
    await writeFile(file(GLIDE), 'not an entity');
    await w.scan();
    expect(s.world.entities.glide?.name).toBe('Glide');
    expect(w.issues()).toEqual([
      expect.objectContaining({
        path: GLIDE,
        code: 'file.frontmatter',
        message: expect.stringContaining('carbon kept its version') as string,
      }),
    ]);
    const n = events.length;
    await w.scan();
    expect(events.length).toBe(n);
    expect(s.snapshot().issues.map((i) => i.path)).toEqual([GLIDE]);
    // Fixed by hand: applied, and the issue clears.
    await editFile('entities/feat/first-descent.md', (e) => e); // unrelated no-op write
    await writeFile(
      file(GLIDE),
      entityToMarkdown({ ...(s.world.entities.glide as Entity), identity: 'Fixed.' }),
    );
    await w.scan();
    expect(s.world.entities.glide?.identity).toBe('Fixed.');
    expect(w.issues()).toEqual([]);
  });

  it('notices changes through fs.watch, and through polling when asked', async () => {
    for (const forcePoll of [false, true]) {
      resetDiskState(dir);
      await writeWorldDir(dir, sampleWorld());
      const { s } = await open();
      const w = new WorldWatcher(dir, s, { debounceMs: 20, pollMs: 50, forcePoll });
      w.start();
      await new Promise((r) => setTimeout(r, 50));
      await editFile(GLIDE, (e) => ({ ...e, identity: `Watched ${forcePoll}` }));
      const deadline = Date.now() + 5000;
      while (s.world.entities.glide?.identity !== `Watched ${forcePoll}` && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      w.stop();
      expect(s.world.entities.glide?.identity).toBe(`Watched ${forcePoll}`);
    }
  });

  it('ignores git, carbon’s own folder, exports, logs and editor droppings', () => {
    for (const p of [
      '.git/index',
      '.carbon/dismissals.json',
      'exports/a.md',
      'ai-log/x.jsonl',
      'entities/item/.x.md.1.2.tmp',
      'entities/item/x.md~',
      'entities/item/.x.md.swp',
      '4913',
    ])
      expect(ignoredPath(p), p).toBe(true);
    expect(ignoredPath('entities/item/x.md')).toBe(false);
  });
});

describe('mergeFile', () => {
  const md = (e: Entity): string => entityToMarkdown(e);
  const glide = sampleWorld().entities.glide as Entity;

  it('takes whichever side changed when only one did', () => {
    expect(mergeFile('a', 'a', 'b', false)).toEqual({ kind: 'take', content: 'b' });
    expect(mergeFile('a', 'b', 'a', false)).toEqual({ kind: 'take', content: 'b' });
    expect(mergeFile('a', 'b', 'b', false)).toEqual({ kind: 'take', content: 'b' });
  });

  it('conflicts on a whole non-entity file changed by both', () => {
    expect(mergeFile('a', 'b', 'c', false)).toMatchObject({
      kind: 'merged',
      conflicts: [{ key: '(file)' }],
    });
  });

  it('conflicts on an entity deleted on one side and edited on the other', () => {
    expect(mergeFile(md(glide), null, md({ ...glide, why: 'x' }), true)).toMatchObject({
      kind: 'merged',
      ifOurs: null,
    });
  });

  it('merges fields, attributes and relations independently', () => {
    const base = { ...glide, attributes: { a: 1 } };
    const ours = { ...base, attributes: { a: 2 }, why: 'w' };
    const theirs = { ...base, fields: { ...base.fields, verb: 'soar' }, tags: ['t'] };
    const r = mergeFile(md(base), md(ours), md(theirs), true);
    expect(r.kind).toBe('take');
    const e = r.kind === 'take' && r.content ? entityFromMarkdown(r.content) : null;
    expect(e?.ok && e.value).toMatchObject({
      attributes: { a: 2 },
      why: 'w',
      tags: ['t'],
      fields: { verb: 'soar' },
    });
  });

  it('property: with no overlapping edits, the merge contains both sides’ changes', () => {
    const keys = ['identity', 'why', 'description'] as const;
    fc.assert(
      fc.property(
        fc.subarray([...keys]),
        fc.string({ minLength: 1 }).filter((s) => s.trim() === s && !s.includes('\r')),
        (mineKeys, value) => {
          const ours: Entity = { ...glide };
          const theirs: Entity = { ...glide };
          for (const k of keys) {
            if (mineKeys.includes(k)) ours[k] = `${value} (ours)`;
            else theirs[k] = `${value} (theirs)`;
          }
          const r = mergeFile(md(glide), md(ours), md(theirs), true);
          if (r.kind !== 'take' || !r.content) return false;
          const e = entityFromMarkdown(r.content);
          return (
            e.ok && keys.every((k) => e.value[k] === (mineKeys.includes(k) ? ours[k] : theirs[k]))
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('applyFileChanges', () => {
  it('keeps an outside edit that inverts a band (no issue, so the watcher takes it)', () => {
    const w = sampleWorld();
    const low = w.entities['low-sky'] as Entity;
    const r = applyFileChanges(
      w,
      new Map([
        ['entities/band/low-sky.md', md({ ...low, fields: { ...low.fields, y_bottom: 900 } })],
      ]),
    );
    expect(r.issues).toEqual([]);
    expect(r.world.entities['low-sky']?.fields.y_bottom).toBe(900);
  });

  it('property: equals re-reading every file with the changes applied', () => {
    const base = sampleWorld();
    // With intent curves: numbers/curves.json is a root file like the others.
    const w = {
      ...base,
      numbers: { ...base.numbers, curves: [{ id: 'c1', y: 'x', over: { axis: 'tier' as const } }] },
    };
    const all = worldToFiles(w);
    const paths = [...all.keys()];
    const glide = w.entities.glide as Entity;
    const changeArb = fc.oneof(
      fc.constantFrom(...paths).map((p) => [p, null] as const),
      fc.constantFrom(...paths).map((p) => [p, 'garbage'] as const),
      fc.string().map((s) => ['numbers/formulas.carbon', s] as const),
      fc
        .constantFrom('a', 'b')
        .map(
          (id) =>
            [
              `entities/capability/${id}.md`,
              md({ ...glide, id, name: id, relations: [] }),
            ] as const,
        ),
      fc.constant([
        'entities/item/glide.md',
        md({ ...glide, kind: 'item', fields: { subkind: 'tool' } }),
      ] as const),
      // An inverted band: tolerated on load, so tolerated as an outside edit too.
      fc.constant([
        'entities/band/low-sky.md',
        md({
          ...(w.entities['low-sky'] as Entity),
          fields: { ...(w.entities['low-sky'] as Entity).fields, y_bottom: 640, y_top: 96 },
        }),
      ] as const),
      fc.constant(['taste/rules.json', '[{"id":"r","text":"no"}]'] as const),
      fc.constant([
        'numbers/curves.json',
        '[{"id":"c2","y":"x * 2","over":{"axis":"tier"},"intent":[{"x":0,"y":1}]}]',
      ] as const),
      fc.constant(['carbon.json', '{"format":1,"name":"Renamed"}'] as const),
      fc.constant(['spreads/s1.json', '{"id":"s1","created":"x"}'] as const),
    );
    fc.assert(
      fc.property(fc.array(changeArb, { maxLength: 6 }), (list) => {
        const changes = new Map<string, string | null>(list);
        const files = new Map(all);
        for (const [p, c] of changes) {
          if (c === null) files.delete(p);
          else files.set(p, c);
        }
        const full = worldFromFiles(files);
        const fast = applyFileChanges(w, changes);
        // Invalid files: the fast path keeps the old version, the full read drops it,
        // so the two only have to agree when nothing was invalid.
        if (full.issues.length === 0 && fast.issues.length > 0) return false;
        if (fast.issues.length > 0 || full.issues.length > 0) return true;
        expect(fast.world).toEqual(full.world);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  const md = (e: Entity): string => entityToMarkdown(e);
});
