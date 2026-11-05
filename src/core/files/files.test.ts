import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { emptyWorld } from '../model/world';
import { awkwardText, commandArb } from '../testing/arbitraries';
import type { Entity } from '../model/entity';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { entityFromMarkdown, entityToMarkdown } from './entity-file';
import { filesForPatch, PATHS, worldFromFiles, worldToFiles, type FileMap } from './world-files';

describe('entity files', () => {
  it('round-trips every sample entity', () => {
    for (const e of Object.values(sampleWorld().entities)) {
      const r = entityFromMarkdown(entityToMarkdown(e));
      expect(r).toEqual({ ok: true, value: e });
    }
  });

  it('writes the description as the body and fields in a stable order', () => {
    const md = entityToMarkdown({
      ...sampleWorld().entities.hollows!,
      description: 'Deep.\n\nVery deep.',
    });
    expect(md.startsWith('---\nid: hollows\nkind: band\nname: Hollows\n')).toBe(true);
    expect(md.endsWith('---\n\nDeep.\n\nVery deep.\n')).toBe(true);
  });

  it('reports bad files without throwing', () => {
    expect(entityFromMarkdown('no frontmatter')).toMatchObject({
      ok: false,
      error: { code: 'file.frontmatter' },
    });
    expect(entityFromMarkdown('---\na: [\n---\n')).toMatchObject({
      ok: false,
      error: { code: 'file.yaml' },
    });
    expect(entityFromMarkdown('---\n- 1\n---\n')).toMatchObject({
      ok: false,
      error: { code: 'file.yaml' },
    });
    expect(entityFromMarkdown('---\nid: X Y\n---\n')).toMatchObject({
      ok: false,
      error: { code: 'file.invalid' },
    });
    const minimal = entityFromMarkdown(
      `---\nid: a\nkind: feat\nname: A\ncreated: ${SAMPLE_TIME}\nupdated: ${SAMPLE_TIME}\n---\nBody`,
    );
    expect(minimal).toMatchObject({
      ok: true,
      value: { id: 'a', state: 'idea', description: 'Body', relations: [] },
    });
  });
});

describe('entity files: "---" inside the frontmatter', () => {
  // The frontmatter ends at a line that is exactly "---". A "---" at the end of
  // any other line (an identity "Light---", a name "Wait ---", a multi-line
  // why or tag) used to end it early: the file failed to load, and the next
  // open quarantined the entity.
  const g = sampleWorld().entities.glide as Entity;
  const cases: [string, Partial<Entity>][] = [
    ['an identity ending in ---', { identity: 'Light---' }],
    ['a name ending in " ---"', { name: 'Wait ---' }],
    ['a why with a --- line', { why: 'one\n---\ntwo' }],
    ['a tag that looks like frontmatter', { tags: ['---\nx: 1\n---\n'] }],
    [
      'a relation note with ---',
      { relations: [{ type: 'counters', target: 'moss-grazer', note: 'x ---' }] },
    ],
  ];
  for (const [label, patch] of cases)
    it(`reads back ${label}`, () => {
      const e = { ...g, ...patch };
      const r = entityFromMarkdown(entityToMarkdown(e));
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      expect(r.value).toEqual(e);
    });

  it('property: any string in any frontmatter field reads back', () => {
    fc.assert(
      fc.property(
        awkwardText,
        awkwardText,
        fc.array(awkwardText, { maxLength: 3 }),
        (name, why, tags) => {
          const e = {
            ...g,
            name: name.replace(/\r\n?/g, '\n') || 'x',
            why: why.replace(/\r\n?/g, '\n'),
            tags: tags.map((t) => t.replace(/\r\n?/g, '\n')),
          };
          const r = entityFromMarkdown(entityToMarkdown(e));
          if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
          expect(r.value).toEqual(e);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('world files', () => {
  it('round-trips the sample world with no issues', () => {
    const w = sampleWorld();
    const { world, issues } = worldFromFiles(worldToFiles(w));
    expect(issues).toEqual([]);
    expect(world).toEqual(w);
  });

  it('loads an empty directory as an empty world', () => {
    expect(worldFromFiles(new Map())).toEqual({ world: emptyWorld(), issues: [] });
  });

  it('reports invalid, misplaced and duplicate files and keeps the rest', () => {
    const files = worldToFiles(sampleWorld());
    const lantern = files.get(PATHS.entity('item', 'spore-lantern'))!;
    files.set('entities/item/elsewhere.md', lantern);
    files.set('entities/feat/spore-lantern.md', lantern);
    files.set(
      PATHS.entity('item', 'bad'),
      lantern.replace('id: spore-lantern', 'id: bad').replace('subkind: tool', 'subkind: hat'),
    );
    files.set(PATHS.rules, '{');
    files.set(PATHS.patterns, '{"x":1}');
    files.set(PATHS.spread('s1'), JSON.stringify({ id: 's2', created: SAMPLE_TIME }));
    files.set(PATHS.settings, JSON.stringify({ format: 99 }));
    const { world, issues } = worldFromFiles(files);
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ['carbon.json', 'format.newer'],
      ['taste/rules.json', 'file.json'],
      ['taste/patterns.json', 'file.invalid'],
      ['entities/feat/spore-lantern.md', 'file.location'],
      ['entities/item/bad.md', 'file.invalid'],
      ['entities/item/elsewhere.md', 'file.location'],
      ['spreads/s1.json', 'file.location'],
    ]);
    expect(world.entities['spore-lantern']).toBeDefined();
    expect(world.taste.rules).toEqual([]);
  });

  it('property: writing only the files a patch touches gives the same files as writing everything', () => {
    const ids = Object.keys(sampleWorld().entities);
    fc.assert(
      fc.property(fc.array(commandArb(ids), { maxLength: 10 }), (cmds) => {
        let w = sampleWorld();
        const disk: FileMap = worldToFiles(w);
        for (const c of cmds) {
          const r = applyCommand(w, c, { now: SAMPLE_TIME });
          if (!r.ok) continue;
          const { write, remove } = filesForPatch(w, r.value.world, r.value.patch);
          for (const p of remove) disk.delete(p);
          for (const [p, text] of write) disk.set(p, text);
          w = r.value.world;
        }
        expect(new Map([...disk].sort())).toEqual(new Map([...worldToFiles(w)].sort()));
        expect(worldFromFiles(disk).world).toEqual(w);
      }),
      { numRuns: 150 },
    );
  });

  it('handles whole-section patches', () => {
    const before = sampleWorld();
    const after = { ...before, entities: {}, spreads: {} };
    const { write, remove } = filesForPatch(
      { ...before, spreads: { s: { id: 's', created: SAMPLE_TIME } } },
      after,
      [
        { op: 'set', path: ['entities'], value: {} },
        { op: 'set', path: ['spreads'], value: {} },
        { op: 'set', path: ['numbers'], value: after.numbers },
        { op: 'set', path: ['taste'], value: after.taste },
      ],
    );
    expect(remove).toHaveLength(Object.keys(before.entities).length + 1);
    expect([...write.keys()].sort()).toEqual(
      [PATHS.formulas, PATHS.patterns, PATHS.reasons, PATHS.rules, PATHS.variables].sort(),
    );
  });
});
