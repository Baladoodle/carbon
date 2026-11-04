import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { cmd } from '../commands/registry';
import { EntitySchema, type Entity, type Relation } from '../model/entity';
import type { Height } from '../model/fields';
import { emptyWorld, type World } from '../model/world';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { deepFreeze } from '../util/json';
import {
  bandAt,
  bandRange,
  entitiesInBand,
  entitiesInBiome,
  isInBand,
  knownBands,
  placementOf,
  PLACEMENT_REASONS,
  resolvePlacement,
  type Placement,
} from './index';
import { pinRelations } from './commands';
import { resolveFresh } from './resolve';
import { commandArb } from '../testing/arbitraries';

const ctx = { now: '2026-11-04T10:00:00.000Z' };

const ent = (input: Partial<Entity> & Pick<Entity, 'id' | 'kind'>): Entity =>
  EntitySchema.parse({ name: input.id, created: SAMPLE_TIME, updated: SAMPLE_TIME, ...input });

const worldOf = (entities: Entity[]): World => {
  const w = emptyWorld();
  w.entities = Object.fromEntries(entities.map((e) => [e.id, e]));
  return w;
};

const pick = (p: Placement | undefined) =>
  p && { mode: p.mode, reason: p.reason, bands: p.bands, biomes: p.biomes, via: p.via };

describe('resolvePlacement on the sample world', () => {
  const w = deepFreeze(sampleWorld());
  const all = resolvePlacement(w);

  it('places bands by their own edges, endless ends included', () => {
    expect(all.undercroft).toMatchObject({
      mode: 'pinned',
      reason: 'band.edges',
      y: { min: -Infinity, max: -512 },
      bands: ['undercroft'],
    });
    expect(all['high-drift']?.y).toEqual({ min: 640, max: Infinity });
  });

  it('places biomes by their band field', () => {
    expect(pick(all['glowmoss-caverns'])).toEqual({
      mode: 'pinned',
      reason: 'biome.band',
      bands: ['hollows'],
      biomes: [],
      via: ['hollows'],
    });
    expect(all['cloud-reef']?.y).toEqual({ min: 96, max: 640 });
  });

  it('pins by in_band and in_biome relations', () => {
    expect(pick(all['spore-shrine'])).toEqual({
      mode: 'pinned',
      reason: 'pin.relation',
      bands: ['hollows'],
      biomes: ['glowmoss-caverns'],
      via: ['glowmoss-caverns'],
    });
    expect(pick(all.glide)).toMatchObject({ mode: 'pinned', bands: ['low-sky'], biomes: [] });
  });

  it('infers materials, creatures, items and capabilities from their relations', () => {
    expect(pick(all['lumen-spore'])).toEqual({
      mode: 'inferred',
      reason: 'infer.found_in',
      bands: ['hollows'],
      biomes: ['glowmoss-caverns'],
      via: ['glowmoss-caverns'],
    });
    expect(pick(all['reef-ray'])).toMatchObject({
      reason: 'infer.lives_in',
      bands: ['low-sky'],
      biomes: ['cloud-reef'],
    });
    expect(pick(all['vent-glass-visor'])).toMatchObject({
      mode: 'inferred',
      reason: 'infer.made_from',
      bands: ['hollows'],
      biomes: ['ash-vents'],
      via: ['vent-glass'],
    });
    expect(pick(all['fourth-accessory-slot'])).toMatchObject({
      mode: 'inferred',
      reason: 'infer.unlocked_by',
      bands: ['hollows'],
      via: ['first-descent'],
    });
  });

  it('leaves entities with nothing to go on unplaced', () => {
    for (const id of ['sky-coral', 'cinder-sting', 'cloud-anklet'])
      expect(all[id]).toMatchObject({
        mode: 'unplaced',
        reason: 'unplaced.no_source',
        y: null,
        bands: [],
      });
  });

  it('covers every entity and is memoised (an unchanged copy reuses the resolution)', () => {
    expect(Object.keys(all).sort()).toEqual(Object.keys(w.entities).sort());
    expect(resolvePlacement(w)).toBe(all);
    expect(resolvePlacement({ ...w, entities: { ...w.entities } })).toEqual(all);
    expect(resolveFresh({ ...w, entities: { ...w.entities } })).toEqual(all);
  });

  it('has helpers for bands, biomes and heights', () => {
    expect(knownBands(w).map((b) => b.id)).toEqual([
      'undercroft',
      'hollows',
      'groundline',
      'low-sky',
      'high-drift',
    ]);
    expect(bandAt(w, 0)?.id).toBe('groundline');
    expect(bandAt(w, -64)?.id).toBe('groundline');
    expect(bandAt(w, -1e9)?.id).toBe('undercroft');
    expect(bandAt(w, 1e9)?.id).toBe('high-drift');
    expect(entitiesInBiome(w, 'glowmoss-caverns')).toEqual([
      'lumen-spore',
      'moss-grazer',
      'spore-shrine',
    ]);
    expect(entitiesInBand(w, 'low-sky')).toEqual(['cloud-reef', 'glide', 'reef-ray']);
    expect(isInBand(placementOf(w, 'glide'), 'low-sky')).toBe(true);
    expect(isInBand(undefined, 'low-sky')).toBe(false);
    expect(placementOf(w, 'nope')).toBeUndefined();
  });
});

describe('resolver rules', () => {
  const band = (id: string, lo: Height | undefined, hi: Height | undefined, danger?: number) =>
    ent({
      id,
      kind: 'band',
      fields: {
        ...(lo !== undefined ? { y_bottom: lo } : {}),
        ...(hi !== undefined ? { y_top: hi } : {}),
        ...(danger !== undefined ? { danger: { min: danger, max: danger } } : {}),
      },
    });
  const biome = (id: string, b: string) => ent({ id, kind: 'biome', fields: { band: b } });
  const rel = (type: string, target: string): Relation => ({ type, target });

  it('treats bands with missing or inverted edges as unknown', () => {
    const w = worldOf([
      band('a', 0, 10),
      band('b', 10, 5),
      band('c', undefined, 3),
      biome('m', 'b'),
      ent({ id: 'x', kind: 'material', relations: [rel('found_in', 'm')] }),
      ent({ id: 'y', kind: 'capability', relations: [rel('in_band', 'b')] }),
    ]);
    const all = resolvePlacement(w);
    expect(all.b).toMatchObject({ mode: 'unplaced', reason: 'band.no_edges' });
    expect(all.c?.reason).toBe('band.no_edges');
    expect(all.m).toMatchObject({ mode: 'unplaced', reason: 'unplaced.pin_unknown', via: ['b'] });
    expect(all.x?.mode).toBe('unplaced');
    expect(all.y).toMatchObject({ mode: 'unplaced', reason: 'unplaced.pin_unknown', via: ['b'] });
    expect(bandRange(ent({ id: 'q', kind: 'item' }))).toBeNull();
  });

  it('keeps biomes known even when their band is not', () => {
    const w = worldOf([
      band('b', 10, 5),
      biome('m', 'b'),
      ent({ id: 's', kind: 'structure', relations: [rel('in_biome', 'm')] }),
    ]);
    expect(resolvePlacement(w).s).toMatchObject({
      mode: 'unplaced',
      reason: 'unplaced.pin_unknown',
      biomes: ['m'],
      y: null,
      bands: [],
    });
  });

  it('places biomes by in_band when they have no band field', () => {
    const w = worldOf([
      band('a', 0, 10),
      ent({ id: 'm', kind: 'biome', relations: [rel('in_band', 'a')] }),
      ent({ id: 'n', kind: 'biome' }),
    ]);
    expect(resolvePlacement(w).m).toMatchObject({ reason: 'pin.relation', bands: ['a'] });
    expect(resolvePlacement(w).n?.reason).toBe('unplaced.no_source');
  });

  it('unions found_in over biomes and bands, ordered bottom to top', () => {
    const w = worldOf([
      band('hi', 10, 20),
      band('lo', -10, 0),
      band('mid', 0, 10),
      biome('m', 'hi'),
      ent({ id: 'x', kind: 'material', relations: [rel('found_in', 'm'), rel('found_in', 'lo')] }),
    ]);
    expect(resolvePlacement(w).x).toMatchObject({
      reason: 'infer.found_in',
      bands: ['lo', 'hi'],
      biomes: ['m'],
      y: { min: -10, max: 20 },
      via: ['lo', 'm'],
    });
  });

  it('places a material where the creatures that drop it live', () => {
    const w = worldOf([
      band('a', 0, 10),
      ent({ id: 'c', kind: 'creature', relations: [rel('lives_in', 'a'), rel('drops', 'x')] }),
      ent({ id: 'x', kind: 'material' }),
    ]);
    expect(resolvePlacement(w).x).toMatchObject({ reason: 'infer.dropped_by', bands: ['a'] });
  });

  it('places an item at the hardest place among the earliest placeable route step', () => {
    const w = worldOf([
      band('easy', 0, 10, 1),
      band('hard', 10, 20, 5),
      band('harder', 20, 30, 9),
      ent({ id: 'p', kind: 'material', relations: [rel('found_in', 'easy')] }),
      ent({ id: 'q', kind: 'material', relations: [rel('found_in', 'hard')] }),
      ent({ id: 'r', kind: 'material', relations: [rel('found_in', 'harder')] }),
      ent({
        id: 'i',
        kind: 'item',
        fields: {
          subkind: 'tool',
          route: [
            { text: 'think about it' },
            { text: 'gather', needs: ['p', 'q', 'ghost'] },
            { text: 'smelt', needs: ['r'] },
          ],
        },
        relations: [rel('made_from', 'r')],
      }),
    ]);
    expect(resolvePlacement(w).i).toMatchObject({
      mode: 'inferred',
      reason: 'infer.route',
      bands: ['hard'],
      via: ['p', 'q'],
    });
  });

  it('breaks danger ties by distance from Y 0, then id', () => {
    const w = worldOf([
      band('near', 0, 10, 3),
      band('far', -100, -50, 3),
      band('b2', 200, 300),
      band('b1', -300, -200),
      ent({ id: 'x', kind: 'capability', relations: [rel('in_band', 'near')] }),
      ent({ id: 'y', kind: 'capability', relations: [rel('in_band', 'far')] }),
      ent({ id: 'z', kind: 'capability', relations: [rel('in_band', 'b1')] }),
      ent({ id: 'v', kind: 'capability', relations: [rel('in_band', 'b2')] }),
      ent({ id: 'f', kind: 'feat', relations: [rel('requires', 'x'), rel('requires', 'y')] }),
      ent({ id: 'g', kind: 'feat', relations: [rel('requires', 'z'), rel('requires', 'v')] }),
    ]);
    expect(resolvePlacement(w).f?.bands).toEqual(['far']);
    expect(resolvePlacement(w).g?.bands).toEqual(['b1']);
  });

  it('cuts requires cycles without depending on the order of resolution', () => {
    const cyc = [
      band('a', 0, 10),
      ent({ id: 'p', kind: 'capability', relations: [rel('requires', 'q')] }),
      ent({ id: 'q', kind: 'capability', relations: [rel('requires', 'p'), rel('requires', 'r')] }),
      ent({ id: 'r', kind: 'capability', relations: [rel('in_band', 'a')] }),
      ent({ id: 's', kind: 'capability', relations: [rel('requires', 's')] }),
    ];
    const w1 = resolvePlacement(worldOf(cyc));
    const w2 = resolvePlacement(worldOf([...cyc].reverse()));
    expect(w1).toEqual(w2);
    expect(w1.p).toMatchObject({ mode: 'inferred', reason: 'infer.requires', bands: ['a'] });
    expect(w1.q).toMatchObject({ mode: 'inferred', bands: ['a'] });
    expect(w1.s?.mode).toBe('unplaced');
  });

  it('ignores relation targets that do not exist', () => {
    const w = worldOf([
      ent({ id: 'x', kind: 'material', relations: [rel('found_in', 'ghost')] }),
      ent({ id: 'i', kind: 'item', fields: { subkind: 'tool', route: 'not steps' } }),
    ]);
    expect(resolvePlacement(w).x?.reason).toBe('unplaced.no_source');
    expect(resolvePlacement(w).i?.reason).toBe('unplaced.no_source');
  });
});

describe('placement.pin and placement.unpin', () => {
  const base = (): World => deepFreeze(sampleWorld());
  const run = (w: World, c: ReturnType<typeof cmd>) => applyCommand(w, c, ctx);

  it('pins an inferred placement where it is, and unpins it again', () => {
    const r = run(base(), cmd('placement.pin', { id: 'lumen-spore' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pinned = resolvePlacement(r.value.world)['lumen-spore'];
    expect(pinned).toMatchObject({
      mode: 'pinned',
      reason: 'pin.relation',
      bands: ['hollows'],
      biomes: ['glowmoss-caverns'],
    });
    const u = run(r.value.world, cmd('placement.unpin', { id: 'lumen-spore' }));
    expect(u.ok && resolvePlacement(u.value.world)['lumen-spore']?.mode).toBe('inferred');
  });

  it('pins to chosen bands and biomes, replacing earlier pins', () => {
    const r = run(base(), cmd('placement.pin', { id: 'glide', to: ['cloud-reef', 'hollows'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(resolvePlacement(r.value.world).glide).toMatchObject({
      bands: ['hollows', 'low-sky'],
      biomes: ['cloud-reef'],
    });
    const glide = r.value.world.entities.glide;
    expect(glide?.relations.filter((x) => x.type === 'in_band')).toEqual([
      { type: 'in_band', target: 'hollows' },
    ]);
    expect(glide?.updated).toBe(ctx.now);
  });

  it('refuses what it cannot pin', () => {
    const code = (c: ReturnType<typeof cmd>): string => {
      const r = run(base(), c);
      return r.ok ? 'ok' : r.error.code;
    };
    expect(code(cmd('placement.pin', { id: 'ghost' }))).toBe('entity.not_found');
    expect(code(cmd('placement.pin', { id: 'hollows' }))).toBe('placement.own_field');
    expect(code(cmd('placement.pin', { id: 'cloud-reef', to: ['hollows'] }))).toBe(
      'placement.own_field',
    );
    expect(code(cmd('placement.pin', { id: 'sky-coral' }))).toBe('placement.unplaced');
    expect(code(cmd('placement.pin', { id: 'glide' }))).toBe('placement.pinned');
    expect(code(cmd('placement.pin', { id: 'glide', to: ['low-sky'] }))).toBe('placement.same');
    expect(code(cmd('placement.pin', { id: 'glide', to: ['moss-grazer'] }))).toBe(
      'placement.target',
    );
    expect(code(cmd('placement.pin', { id: 'glide', to: ['ghost'] }))).toBe('entity.not_found');
    expect(code(cmd('placement.unpin', { id: 'lumen-spore' }))).toBe('placement.not_pinned');
    expect(code(cmd('placement.unpin', { id: 'hollows' }))).toBe('placement.own_field');
    expect(code(cmd('placement.unpin', { id: 'ghost' }))).toBe('entity.not_found');
  });

  it('respects the relation rules in the schema', () => {
    const w = sampleWorld();
    w.schema = {
      ...w.schema,
      relations: [
        {
          type: 'in_biome',
          label: 'in biome',
          inverseLabel: 'contains',
          from: ['material'],
          to: ['biome'],
          symmetric: false,
          acyclic: false,
        },
      ],
    };
    const r = pinRelations(w, 'glide', ['cloud-reef']);
    expect(!r.ok && r.error.code).toBe('placement.not_allowed');
    expect(pinRelations(w, 'lumen-spore', ['cloud-reef']).ok).toBe(true);
  });
});

// ── Property tests ─────────────────────────────────────────────────────────

const KINDS_PLACED = ['material', 'creature', 'structure', 'capability', 'item', 'feat'] as const;
const REL_TYPES = [
  'in_band',
  'in_biome',
  'found_in',
  'lives_in',
  'made_from',
  'drops',
  'requires',
  'unlocks',
  'pairs_with',
] as const;

/** A random world: bands (some broken), biomes, and entities with arbitrary relations and cycles. */
const worldArb: fc.Arbitrary<Entity[]> = fc
  .record({
    bands: fc.array(
      fc.record({
        lo: fc.oneof(fc.integer({ min: -2000, max: 2000 }), fc.constant('-inf' as const)),
        span: fc.integer({ min: -50, max: 800 }),
        top: fc.boolean(),
        danger: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
      }),
      { minLength: 0, maxLength: 5 },
    ),
    biomes: fc.array(fc.nat(6), { maxLength: 5 }),
    others: fc.array(
      fc.record({
        kind: fc.constantFrom(...KINDS_PLACED),
        rels: fc.array(fc.record({ type: fc.constantFrom(...REL_TYPES), to: fc.nat(30) }), {
          maxLength: 4,
        }),
        route: fc.array(fc.array(fc.nat(30), { maxLength: 3 }), { maxLength: 3 }),
      }),
      { maxLength: 14 },
    ),
  })
  .map(({ bands, biomes, others }) => {
    const ids: string[] = [];
    const out: Entity[] = [];
    bands.forEach((b, i) => {
      const id = `band-${i}`;
      ids.push(id);
      const hi: Height =
        b.top && b.lo !== '-inf' ? '+inf' : b.lo === '-inf' ? b.span : b.lo + b.span;
      out.push(
        ent({
          id,
          kind: 'band',
          fields: {
            y_bottom: b.lo,
            y_top: hi,
            ...(b.danger !== undefined ? { danger: { min: b.danger, max: b.danger } } : {}),
          },
        }),
      );
    });
    biomes.forEach((bi, i) => {
      const id = `biome-${i}`;
      ids.push(id);
      out.push(ent({ id, kind: 'biome', fields: bi < bands.length ? { band: `band-${bi}` } : {} }));
    });
    const start = ids.length;
    others.forEach((_, i) => ids.push(`e-${start + i}`));
    others.forEach((o, i) => {
      const at = (n: number): string => ids[n % ids.length] ?? 'ghost';
      out.push(
        ent({
          id: `e-${start + i}`,
          kind: o.kind,
          fields:
            o.kind === 'item'
              ? {
                  subkind: 'tool',
                  route: o.route.map((needs) => ({ text: 's', needs: needs.map(at) })),
                }
              : {},
          relations: o.rels.map((r) => ({ type: r.type, target: at(r.to) })),
        }),
      );
    });
    return out;
  });

describe('placement properties', () => {
  it('every placement lies within known bands, or is unplaced', () => {
    fc.assert(
      fc.property(worldArb, (entities) => {
        const w = worldOf(entities);
        const known = new Map(knownBands(w).map((b) => [b.id, b]));
        const all = resolvePlacement(w);
        expect(Object.keys(all).sort()).toEqual(entities.map((e) => e.id).sort());
        const lowest = Math.min(...[...known.values()].map((b) => b.y.min));
        const highest = Math.max(...[...known.values()].map((b) => b.y.max));
        for (const [id, p] of Object.entries(all)) {
          expect(p.id).toBe(id);
          expect(PLACEMENT_REASONS).toContain(p.reason);
          if (p.mode === 'unplaced') {
            expect(p.y).toBeNull();
            expect(p.bands).toEqual([]);
            expect(p.reason === 'band.no_edges' || p.reason.startsWith('unplaced.')).toBe(true);
            continue;
          }
          expect(p.bands.length).toBeGreaterThan(0);
          expect(p.y).not.toBeNull();
          for (const b of p.bands) expect(known.has(b)).toBe(true);
          const ranges = p.bands.map((b) => known.get(b)?.y ?? { min: NaN, max: NaN });
          expect(p.y).toEqual({
            min: Math.min(...ranges.map((r) => r.min)),
            max: Math.max(...ranges.map((r) => r.max)),
          });
          expect(p.y?.min).toBeGreaterThanOrEqual(lowest);
          expect(p.y?.max).toBeLessThanOrEqual(highest);
          // Bands are ordered bottom to top.
          const order = [...known.keys()];
          expect([...p.bands].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(p.bands);
          expect(p.mode === 'inferred').toBe(p.reason.startsWith('infer.'));
        }
        for (const p of Object.values(all))
          for (const b of p.biomes) expect(w.entities[b]?.kind).toBe('biome');
      }),
      { numRuns: 300 },
    );
  });

  it('is deterministic whatever order the entities are in', () => {
    fc.assert(
      fc.property(
        worldArb.chain((es) =>
          fc.tuple(fc.constant(es), fc.shuffledSubarray(es, { minLength: es.length })),
        ),
        ([a, b]) => {
          expect(resolvePlacement(worldOf(b))).toEqual(resolvePlacement(worldOf(a)));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('pinning an inferred placement keeps its bands; undo restores it exactly', () => {
    fc.assert(
      fc.property(worldArb, (entities) => {
        const w = worldOf(entities);
        const before = resolvePlacement(w);
        for (const p of Object.values(before)) {
          if (p.mode !== 'inferred') continue;
          const r = applyCommand(w, cmd('placement.pin', { id: p.id }), ctx);
          // Random worlds can break the relation rules (e.g. a feat in a biome is fine,
          // but the schema refuses pins whose kinds don't match); those are refused cleanly.
          if (!r.ok) {
            expect(r.error.code).toMatch(/^(placement|world)\./);
            continue;
          }
          const after = resolvePlacement(r.value.world)[p.id];
          expect(after?.mode).toBe('pinned');
          expect(after?.bands).toEqual(p.bands);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe('reuse across worlds', () => {
  it('a rename or a state change reuses the resolution; a relation change does not', () => {
    const w = sampleWorld();
    const a = resolvePlacement(w);
    const renamed = applyCommand(
      w,
      cmd('entity.update', { id: 'vent-glass', set: { name: 'Vent Glass II' } }),
      { now: SAMPLE_TIME },
    );
    if (!renamed.ok) throw new Error(renamed.error.message);
    expect(resolvePlacement(renamed.value.world)).toBe(a);
    const moved = applyCommand(
      renamed.value.world,
      cmd('relation.add', { from: 'cinder-sting', type: 'in_band', to: 'high-drift' }),
      { now: SAMPLE_TIME },
    );
    if (!moved.ok) throw new Error(moved.error.message);
    const b = resolvePlacement(moved.value.world);
    expect(b).not.toBe(a);
    expect(b['cinder-sting']?.bands).toEqual(['high-drift']);
  });

  it('property: after any command sequence, the reused resolution equals a fresh one', () => {
    const base = sampleWorld();
    const ids = Object.keys(base.entities);
    fc.assert(
      fc.property(fc.array(commandArb(ids), { maxLength: 12 }), (commands) => {
        let w = base;
        for (const c of commands) {
          const r = applyCommand(w, c, { now: SAMPLE_TIME });
          if (r.ok) w = r.value.world;
          expect(resolvePlacement(w)).toEqual(resolveFresh(w));
        }
      }),
      { numRuns: 120 },
    );
  });
});
