import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { cmd } from '../commands/registry';
import type { Entity, EntityInput } from '../model/entity';
import { EntitySchema } from '../model/entity';
import { emptyWorld, type World } from '../model/world';
import { commandArb } from '../testing/arbitraries';
import { SAMPLE_TIME, sampleWorld } from '../testing/sample';
import { seededRandom } from '../util/hash';
import { CHECK_KINDS } from './checks';
import { compareNames, editDistance, nameDistance, nameSignature, normaliseName } from './names';
import type { NumbersAdapter } from './numbers';
import { resolvePlacement } from '../placement';
import { bandSpans, heightOf, resolvedPlaces } from './placement';
import { createCheckRunner, runChecks } from './runner';

const ent = (input: Omit<EntityInput, 'created' | 'updated'>): Entity =>
  EntitySchema.parse({ created: SAMPLE_TIME, updated: SAMPLE_TIME, ...input });

const band = (id: string, bottom: number | '-inf', top: number | '+inf'): Entity =>
  ent({ id, kind: 'band', name: id.replace(/-/g, ' '), fields: { y_bottom: bottom, y_top: top } });

/** Five bands, from the depths to the sky. */
function bandsWorld(extra: Entity[] = []): World {
  const w = emptyWorld();
  for (const e of [
    band('deep', '-inf', -500),
    band('under', -500, -50),
    band('ground', -50, 50),
    band('sky', 50, 500),
    band('high', 500, '+inf'),
    ...extra,
  ])
    w.entities[e.id] = e;
  return w;
}

const byKind = (w: World, kind: string): ReturnType<typeof runChecks> =>
  runChecks(w).filter((n) => n.kind === kind);
const ctx = { now: '2026-11-04T10:00:00.000Z' };

describe('overlapping bands', () => {
  it('flags two bands that share heights, with the overlap, and nothing for bands that only touch', () => {
    expect(byKind(bandsWorld(), 'band-overlap')).toEqual([]);
    expect(byKind(sampleWorld(), 'band-overlap')).toEqual([]);
    const w = bandsWorld([band('mist', 400, 700)]);
    const notes = byKind(w, 'band-overlap');
    expect(notes.map((n) => [n.id, n.entities, n.text])).toEqual([
      ['check:band-overlap:high:mist', ['high', 'mist'], 'high and mist overlap from 500 to 700'],
      ['check:band-overlap:mist:sky', ['mist', 'sky'], 'mist and sky overlap from 400 to 500'],
    ]);
    expect(notes[1]?.y).toBe(450);
    expect(notes.every((n) => n.severity === 'warn')).toBe(true);
  });

  it('names an endless overlap, and leaves out graveyard bands', () => {
    const top = byKind(bandsWorld([band('void', 800, '+inf')]), 'band-overlap');
    expect(top.map((n) => n.text)).toEqual(['high and void overlap above 800']);
    const dead = { ...band('void', 800, '+inf'), state: 'graveyard' as const };
    expect(byKind(bandsWorld([dead]), 'band-overlap')).toEqual([]);
  });

  it('follows edits incrementally: resizing a band clears the note', () => {
    const runner = createCheckRunner();
    const w = bandsWorld([band('mist', 400, 700)]);
    expect(runner.run(w).filter((n) => n.kind === 'band-overlap')).toHaveLength(2);
    const r = applyCommand(
      w,
      cmd('entity.setField', { id: 'mist', field: 'y_bottom', value: 500 }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    // mist no longer reaches into sky; it still overlaps high.
    const after = runner.run(r.value.world).filter((n) => n.kind === 'band-overlap');
    expect(after.map((n) => n.entities)).toEqual([['high', 'mist']]);
    expect(runner.run(r.value.world)).toEqual(runChecks(r.value.world));
  });
});

describe('placement (from the resolver)', () => {
  it('is resolvePlacement: every placed entity, its bands sorted, inferred when the resolver infers', () => {
    const w = sampleWorld();
    const p = resolvedPlaces(w);
    const r = resolvePlacement(w);
    for (const [id, pl] of Object.entries(r)) {
      if (pl.bands.length === 0) expect(p.has(id)).toBe(false);
      else
        expect(p.get(id)).toEqual({
          bands: [...pl.bands].sort(),
          inferred: pl.mode === 'inferred',
        });
    }
    expect(p.get('low-sky')).toEqual({ bands: ['low-sky'], inferred: false });
    expect(p.get('cloud-reef')?.inferred).toBe(false);
    // Memoised per entities object.
    expect(resolvedPlaces({ ...w })).toBe(p);
  });

  it('infers an item from its route, earliest step first', () => {
    const w = bandsWorld([
      ent({
        id: 'ore',
        kind: 'material',
        name: 'Ore',
        relations: [{ type: 'found_in', target: 'under' }],
      }),
      ent({
        id: 'cloud',
        kind: 'material',
        name: 'Cloud',
        relations: [{ type: 'found_in', target: 'sky' }],
      }),
      ent({
        id: 'pick',
        kind: 'item',
        name: 'Pick',
        fields: {
          subkind: 'tool',
          route: [
            { text: 'mine', needs: ['ore'] },
            { text: 'fly', needs: ['cloud'] },
          ],
        },
      }),
    ]);
    expect(resolvedPlaces(w).get('pick')).toEqual({ bands: ['under'], inferred: true });
  });

  it('bandSpans sorts bands and heightOf clamps the endless ends', () => {
    const spans = bandSpans(bandsWorld());
    expect(spans.map((s) => s.id)).toEqual(['deep', 'under', 'ground', 'sky', 'high']);
    expect(heightOf(['ground'], spans)).toBe(0);
    expect(heightOf(['deep'], spans)).toBe(-532);
    expect(heightOf(['high'], spans)).toBe(532);
    expect(heightOf([], spans)).toBeUndefined();
  });
});

describe('lanes', () => {
  it('flags a run of two or more empty bands in a lane that has something', () => {
    const w = bandsWorld([
      ent({
        id: 'wasp',
        kind: 'creature',
        name: 'Wasp',
        relations: [{ type: 'lives_in', target: 'deep' }],
      }),
    ]);
    const notes = byKind(w, 'lane-empty');
    expect(notes).toEqual([
      expect.objectContaining({
        id: 'check:lane-empty:creatures:under..high',
        text: 'No creatures in under, ground, sky and high',
        entities: ['under', 'ground', 'sky', 'high'],
      }),
    ]);
    // Lanes with nothing at all aren't flagged (the Column shows that already).
    expect(notes.some((n) => n.id.includes(':items:'))).toBe(false);
  });

  it('a single empty band is not a run', () => {
    const w = bandsWorld(
      ['deep', 'under', 'sky', 'high'].map((b) =>
        ent({
          id: `c-${b}`,
          kind: 'creature',
          name: `Creature ${b}`,
          relations: [{ type: 'lives_in', target: b }],
        }),
      ),
    );
    expect(byKind(w, 'lane-empty')).toEqual([]);
  });

  it('flags depth/sky imbalance per lane, counting each entity once', () => {
    const deep = [1, 2, 3, 4].map((i) =>
      ent({
        id: `m${i}`,
        kind: 'material',
        name: `Mineral ${i}`,
        relations: [
          { type: 'found_in', target: 'under' },
          { type: 'found_in', target: 'deep' },
        ],
      }),
    );
    const notes = byKind(bandsWorld(deep), 'lane-imbalance');
    expect(notes).toEqual([
      expect.objectContaining({
        id: 'check:lane-imbalance:materials',
        text: 'Materials lean to the depths: 4 below 0, 0 above',
      }),
    ]);
    expect(notes[0]?.y).toBeLessThan(0);
    const balanced = bandsWorld([
      ...deep.slice(0, 2),
      ...[1, 2].map((i) =>
        ent({
          id: `s${i}`,
          kind: 'material',
          name: `Sky stuff ${i}`,
          relations: [{ type: 'found_in', target: 'sky' }],
        }),
      ),
    ]);
    expect(byKind(balanced, 'lane-imbalance')).toEqual([]);
  });
});

describe('nowhere and unreachable', () => {
  it('a material found nowhere, unless something drops it', () => {
    const w = bandsWorld([ent({ id: 'dust', kind: 'material', name: 'Dust' })]);
    expect(byKind(w, 'material-nowhere').map((n) => n.id)).toEqual(['check:material-nowhere:dust']);
    w.entities.mite = ent({
      id: 'mite',
      kind: 'creature',
      name: 'Mite',
      relations: [
        { type: 'drops', target: 'dust' },
        { type: 'lives_in', target: 'sky' },
      ],
    });
    expect(byKind(w, 'material-nowhere')).toEqual([]);
  });

  it('a creature living nowhere', () => {
    const w = bandsWorld([ent({ id: 'ghost', kind: 'creature', name: 'Ghost' })]);
    expect(byKind(w, 'creature-nowhere').map((n) => n.entities)).toEqual([['ghost']]);
  });

  it('an item whose route needs what doesn’t exist, is dead, or is itself unreachable', () => {
    const w = bandsWorld([
      ent({
        id: 'gone',
        kind: 'material',
        name: 'Gone',
        state: 'graveyard',
        killed: { reason: '2' },
      }),
      ent({
        id: 'a',
        kind: 'item',
        name: 'A',
        fields: { subkind: 'tool', route: [{ text: 'x', needs: ['nope'] }] },
      }),
      ent({
        id: 'b',
        kind: 'item',
        name: 'B',
        fields: { subkind: 'tool', route: [{ text: 'x', needs: ['a', 'gone'] }] },
      }),
      ent({
        id: 'c1',
        kind: 'item',
        name: 'C1',
        fields: { subkind: 'tool', route: [{ text: 'x', needs: ['c2'] }] },
      }),
      ent({
        id: 'c2',
        kind: 'item',
        name: 'C2',
        fields: { subkind: 'tool', route: [{ text: 'x', needs: ['c1'] }] },
      }),
      ent({
        id: 'ok',
        kind: 'item',
        name: 'Ok',
        fields: { subkind: 'tool', route: [{ text: 'x', needs: ['deep'] }] },
      }),
    ]);
    const notes = byKind(w, 'item-unreachable');
    expect(notes.map((n) => [n.entities[0], n.text])).toEqual([
      ['a', 'Unreachable: its route needs "nope" (doesn\'t exist)'],
      ['b', 'Unreachable: its route needs A (unreachable) and Gone (in the graveyard)'],
      ['c1', 'Unreachable: its route needs C2 (unreachable)'],
      ['c2', 'Unreachable: its route needs C1 (unreachable)'],
    ]);
  });
});

describe('relations, cycles and required fields', () => {
  it('dangling and invalid relations become notes, both ends named when they exist', () => {
    const w = bandsWorld([
      ent({
        id: 'x',
        kind: 'material',
        name: 'X',
        relations: [
          { type: 'found_in', target: 'missing' },
          { type: 'found_in', target: 'sky' },
        ],
      }),
      ent({
        id: 'y',
        kind: 'item',
        name: 'Y',
        fields: { subkind: 'tool' },
        relations: [{ type: 'pairs_with', target: 'x' }],
      }),
    ]);
    const notes = byKind(w, 'relation');
    expect(notes.map((n) => [n.id, n.severity, n.entities])).toEqual([
      ['check:relation:x:relation.dangling:found_in:missing', 'warn', ['x']],
      ['check:relation:y:relation.asymmetric:pairs_with:x', 'warn', ['y', 'x']],
    ]);
  });

  it('a supersedes cycle is one note, the same from every member', () => {
    const w = bandsWorld([
      ent({
        id: 'i1',
        kind: 'item',
        name: 'One',
        fields: { subkind: 'tool' },
        relations: [{ type: 'supersedes', target: 'i2' }],
      }),
      ent({
        id: 'i2',
        kind: 'item',
        name: 'Two',
        fields: { subkind: 'tool' },
        relations: [{ type: 'supersedes', target: 'i3' }],
      }),
      ent({
        id: 'i3',
        kind: 'item',
        name: 'Three',
        fields: { subkind: 'tool' },
        relations: [{ type: 'supersedes', target: 'i1' }],
      }),
    ]);
    const notes = byKind(w, 'cycle');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      severity: 'error',
      text: 'Supersedes goes in a circle: One → Two → Three → One',
      entities: ['i1', 'i2', 'i3'],
    });
  });

  it('required fields for the state, by their labels', () => {
    const w = bandsWorld([
      ent({
        id: 'lamp',
        kind: 'item',
        name: 'Lamp',
        state: 'shaped',
        fields: { subkind: 'tool' },
        identity: 'Light.',
      }),
    ]);
    expect(byKind(w, 'required-missing').map((n) => n.text)).toEqual([
      'Shaped needs change and trade-off',
    ]);
  });
});

describe('names', () => {
  it('normalises', () => {
    expect(normaliseName('  The Glass—Lung! ')).toBe('glass lung');
    expect(normaliseName('Élan')).toBe('elan');
  });

  it('edit distance, banded', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('kitten', 'sitting', 1)).toBe(2);
    expect(editDistance('', 'abc')).toBe(3);
    expect(nameDistance('abcd', 'abce')).toBe(0.25);
  });

  it('property: banded distance agrees with the full one up to the band', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }),
        fc.string({ maxLength: 12 }),
        fc.nat(6),
        (a, b, max) => {
          const full = editDistance(a, b);
          const banded = editDistance(a, b, max);
          return full <= max ? banded === full : banded === max + 1;
        },
      ),
    );
  });

  it('same and near names across kinds, but not short or distant ones', () => {
    expect(compareNames('glass lung', 'glass lung')).toBe('same');
    expect(compareNames('glass lung', 'glass lungs')).toBe('near');
    expect(compareNames('ash', 'ask')).toBeNull();
    // A numbered series isn't a near-duplicate; the same name still is.
    expect(compareNames('ore 0001', 'ore 0002')).toBeNull();
    expect(compareNames('tier 2 plate', 'tier 3 plate')).toBeNull();
    expect(compareNames('ore 0001', 'ore 0001')).toBe('same');
    expect(compareNames('glass lung 2', 'glass lungs 2')).toBe('near');
    expect(compareNames('glass lung', 'cloud anklet')).toBeNull();
    const w = bandsWorld([
      ent({ id: 'a', kind: 'item', name: 'Glass Lung', fields: { subkind: 'tool' } }),
      ent({ id: 'b', kind: 'material', name: 'glass-lung' }),
      ent({ id: 'c', kind: 'material', name: 'Glass Lungs' }),
      ent({
        id: 'd',
        kind: 'material',
        name: 'Glass Lung',
        state: 'graveyard',
        killed: { reason: '2' },
      }),
    ]);
    const notes = runChecks(w).filter((n) => n.kind.endsWith('name'));
    expect(notes.map((n) => [n.kind, n.entities])).toEqual([
      ['duplicate-name', ['a', 'b']],
      ['near-duplicate-name', ['a', 'c']],
      ['near-duplicate-name', ['b', 'c']],
    ]);
  });
});

describe('numbers, through the adapter (W3 stub)', () => {
  const stub: NumbersAdapter = {
    formulaProblems: () => [
      { message: 'unknown name "kk"', name: 'taken', span: { start: 3, end: 5 } },
    ],
    curveDeviations: () => [
      { entity: 'deep', attribute: 'defense', value: 40, expected: 10, tolerance: 5 },
      { entity: 'sky', attribute: 'defense', value: 12, expected: 10, tolerance: 5 },
    ],
  };
  it('formula errors and attributes far off their curve', () => {
    const notes = runChecks(bandsWorld(), { numbers: stub });
    expect(
      notes.filter((n) => n.kind === 'formula-error').map((n) => [n.severity, n.text]),
    ).toEqual([['error', 'taken: unknown name "kk"']]);
    expect(notes.filter((n) => n.kind === 'off-curve').map((n) => [n.id, n.text])).toEqual([
      ['check:off-curve:deep:defense', 'deep is far off defense: 40, intent 10 ± 5'],
    ]);
  });
});

describe('notes are well formed and stable', () => {
  it('every note: a known kind, a check: id, an inputs hash, ids sorted and unique', () => {
    const notes = runChecks(sampleWorld());
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(CHECK_KINDS).toContain(n.kind);
      expect(n.id.startsWith(`check:${n.kind}:`)).toBe(true);
      expect(n.inputsHash).toMatch(/^[0-9a-f]{16}$/);
      expect(n.source).toBe('check');
    }
    expect(new Set(notes.map((n) => n.id)).size).toBe(notes.length);
    expect(notes.map((n) => n.id)).toEqual([...notes.map((n) => n.id)].sort());
  });

  it('is deterministic, and an unrelated edit keeps a note’s id and inputs hash', () => {
    const w = sampleWorld();
    const a = runChecks(w);
    expect(runChecks(sampleWorld())).toEqual(a);
    const r = applyCommand(
      w,
      cmd('entity.update', { id: 'glide', set: { description: 'Unrelated.' } }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    const b = runChecks(r.value.world);
    const nowhere = (ns: typeof a) => ns.find((n) => n.id === 'check:material-nowhere:sky-coral');
    expect(nowhere(b)).toEqual(nowhere(a));
  });
});

describe('the incremental runner', () => {
  const ids = Object.keys(sampleWorld().entities);

  it('property: after any sequence of commands, incremental = from scratch', () => {
    fc.assert(
      fc.property(
        fc.array(commandArb([...ids, 'new-thing']), { minLength: 1, maxLength: 15 }),
        (cmds) => {
          const runner = createCheckRunner();
          let w = sampleWorld();
          runner.run(w);
          for (const c of cmds) {
            const r = applyCommand(w, c, ctx);
            if (!r.ok) continue;
            w = r.value.world;
            expect(runner.run(w)).toEqual(runChecks(w));
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  it('is fast on a big world: 2,000 entities, one edit', () => {
    const w = bandsWorld();
    const kinds = ['material', 'creature', 'item', 'structure', 'capability', 'feat'] as const;
    const bands = ['deep', 'under', 'ground', 'sky', 'high'];
    // Made-up names of one to three words, like a real world's (deterministic).
    const rnd = seededRandom('names');
    const syl = [
      'ka',
      'lo',
      'mi',
      'ren',
      'tha',
      'vor',
      'sel',
      'dun',
      'ash',
      'eth',
      'gri',
      'pel',
      'ul',
      'zan',
      'qui',
      'bro',
    ];
    const word = (): string =>
      Array.from(
        { length: 2 + Math.floor(rnd() * 2) },
        () => syl[Math.floor(rnd() * syl.length)] ?? '',
      ).join('');
    const nameOf = (): string => Array.from({ length: 1 + Math.floor(rnd() * 3) }, word).join(' ');
    for (let i = 0; i < 2000; i++) {
      const kind = kinds[i % kinds.length] ?? 'material';
      const target = bands[i % bands.length] ?? 'sky';
      const rel = kind === 'material' ? 'found_in' : kind === 'creature' ? 'lives_in' : 'in_band';
      w.entities[`e${i}`] = ent({
        id: `e${i}`,
        kind,
        name: nameOf(),
        ...(kind === 'item' ? { fields: { subkind: 'tool' } } : {}),
        relations: [{ type: rel, target }],
      });
    }
    const runner = createCheckRunner();
    const t0 = performance.now();
    runner.run(w);
    const full = performance.now() - t0;
    const r = applyCommand(
      w,
      cmd('entity.update', { id: 'e5', set: { name: 'Renamed thing' } }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    const t1 = performance.now();
    const notes = runner.run(r.value.world);
    const incremental = performance.now() - t1;
    expect(notes).toEqual(runChecks(r.value.world));
    // A full run of 2,000 entities stays well under a second; one edit, a frame or two.
    expect(full).toBeLessThan(1500);
    expect(incremental).toBeLessThan(Math.max(40, full / 3));
  });
});

describe('name signatures', () => {
  it('property: the histogram filter never rejects a real near-duplicate', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9 ]{4,16}$/),
        fc.stringMatching(/^[a-z0-9 ]{4,16}$/),
        (a, b) => {
          return compareNames(a, b, [nameSignature(a), nameSignature(b)]) === compareNames(a, b);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('numbers, through the numbers engine', () => {
  const apply = (w: World, ...cs: Parameters<typeof applyCommand>[1][]): World => {
    for (const c of cs) {
      const r = applyCommand(w, c, ctx);
      if (!r.ok) throw new Error(r.error.message);
      w = r.value.world;
    }
    return w;
  };

  it('a formula error is a note, and fixing the formula removes it', () => {
    const w = apply(sampleWorld(), cmd('numbers.setFormulas', { source: 'bad = nope * 2\n' }));
    const notes = runChecks(w).filter((n) => n.kind === 'formula-error');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toMatch(/^bad: .*nope/);
    const fixed = apply(w, cmd('numbers.setFormulas', { source: 'bad = 2\n' }));
    expect(runChecks(fixed).filter((n) => n.kind === 'formula-error')).toEqual([]);
  });

  it('an attribute far off its intent curve is a note at the entity, until it is brought back', () => {
    const curve = {
      id: 'defense',
      y: 'band_defense(x)',
      over: { axis: 'band' as const },
      dots: { query: 'items where subkind == "armor"', value: '.defense' },
    };
    const w = apply(
      sampleWorld(),
      cmd('numbers.setFormulas', {
        source:
          'band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)\n',
      }),
      cmd('relation.add', { from: 'vent-glass-visor', type: 'in_band', to: 'hollows' }),
      cmd('numbers.putCurve', { curve }),
      cmd('numbers.setIntent', {
        id: 'defense',
        points: [
          { x: 'undercroft', y: 20 },
          { x: 'hollows', y: 20 },
          { x: 'groundline', y: 20 },
          { x: 'low-sky', y: 20 },
          { x: 'high-drift', y: 20 },
        ],
      }),
    );
    const off = runChecks(w).filter((n) => n.kind === 'off-curve');
    expect(off.map((n) => n.entities)).toEqual([['vent-glass-visor']]);
    expect(off[0]!.y).toBeDefined();
    const back = apply(
      w,
      cmd('entity.setAttribute', { id: 'vent-glass-visor', key: 'defense', value: 20 }),
    );
    expect(runChecks(back).filter((n) => n.kind === 'off-curve')).toEqual([]);
  });
});
