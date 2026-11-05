import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FakeAiGateway } from '../ai/fake';
import { MOVES, type Candidate, type Move, type Spot } from '../ai/moments';
import { applyCommand, applyCommands } from '../commands/apply';
import { applyPatch } from '../commands/patch';
import { cmd } from '../commands/registry';
import { getEntity, type World } from '../model/world';
import { sampleWorld } from '../testing/sample';
import { deepEqual } from '../util/json';
import { AXIS_LIBRARY, MOVE_DEFS, MOVE_LIST, moveByKey } from './moves';
import {
  allJudgements,
  allSpreads,
  makeSpread,
  newSpreadId,
  openCandidates,
  readSpread,
  type SpreadData,
} from './record';
import {
  bandOf,
  checkSpot,
  defaultMove,
  movesFor,
  sameSpot,
  spotBand,
  spotEntities,
  spotFromUi,
  spotKind,
  spotLabel,
  spotSlug,
} from './spot';
import {
  candidateRole,
  cleanFields,
  cleanRelations,
  followSpot,
  keepCommands,
  killCommands,
  mergeCommands,
  targetOf,
} from './triage';
import { packContext } from '../context';

const NOW = '2026-11-04T10:00:00.000Z';
const ctx = { now: NOW };

const cand = (key: string, over: Partial<Candidate> = {}): Candidate => ({
  key,
  kind: 'item',
  name: `Candidate ${key}`,
  identity: `It does thing ${key}.`,
  fields: {},
  attributes: {},
  relations: [],
  position: { x: 0.5, y: 0.5 },
  wildcard: false,
  ...over,
});

const AXES = MOVE_DEFS.fill.axes;

function spreadIn(
  world: World,
  spot: Spot,
  move: Move,
  candidates: Candidate[],
  id = 's1',
): { world: World; spread: SpreadData } {
  const spread = makeSpread({
    id,
    now: NOW,
    request: { spot, move, count: Math.max(1, candidates.length), axes: AXES, ruleIds: [] },
    candidates,
    status: 'done',
  });
  const r = applyCommand(world, cmd('spread.save', { record: spread }), ctx);
  if (!r.ok) throw new Error(r.error.message);
  return { world: r.value.world, spread };
}

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const apply = (world: World, commands: Parameters<typeof applyCommands>[1]) =>
  must(applyCommands(world, commands, ctx));

describe('moves', () => {
  it('defines all nine moves with the keys of EXPERIENCE.md §4', () => {
    expect(MOVE_LIST.map((m) => m.move)).toEqual([...MOVES]);
    expect(Object.fromEntries(MOVE_LIST.map((m) => [m.move, m.key]))).toEqual({
      fill: 'f',
      vary: 'v',
      oppose: 'o',
      alloy: 'a',
      push: 'p',
      ground: 'g',
      cost: 'c',
      break: 'r',
      name: 'n',
    });
    expect(new Set(MOVE_LIST.map((m) => m.key)).size).toBe(9);
    for (const m of MOVE_LIST) {
      expect(moveByKey(m.key)).toBe(m);
      expect(m.spots.length).toBeGreaterThan(0);
      expect(AXIS_LIBRARY.map((a) => a.label)).toContain(m.axes.x.label);
      expect(AXIS_LIBRARY.map((a) => a.label)).toContain(m.axes.y.label);
      expect(m.axes.x.label).not.toBe(m.axes.y.label);
    }
    expect(moveByKey('z')).toBeUndefined();
  });

  it('marks what candidates become', () => {
    expect(MOVE_LIST.filter((m) => m.output === 'about').map((m) => m.move)).toEqual([
      'ground',
      'cost',
      'name',
    ]);
    expect(MOVE_LIST.filter((m) => m.output === 'finding').map((m) => m.move)).toEqual(['break']);
    expect(MOVE_DEFS.alloy.minEntities).toBe(2);
    expect(new Set(AXIS_LIBRARY.map((a) => a.label)).size).toBe(AXIS_LIBRARY.length);
  });
});

describe('spots', () => {
  const w = sampleWorld();
  const cell: Spot = { type: 'cell', band: 'low-sky', lane: 'items' };
  const region: Spot = {
    type: 'region',
    band: 'hollows',
    climate: { temperature: { min: 0, max: 0.3 }, moisture: { min: 0, max: 0.4 } },
  };

  it('knows its kind, band and entities', () => {
    expect(spotKind(w, cell)).toBe('item');
    expect(spotKind(w, { type: 'cell', band: 'low-sky', lane: 'creatures' })).toBe('creature');
    expect(spotKind(w, region)).toBe('biome');
    expect(spotKind(w, { type: 'entity', entity: 'glide' })).toBe('capability');
    expect(spotKind(w, { type: 'note', note: 'x', entities: [] })).toBe('item');
    expect(spotBand(w, cell)).toBe('low-sky');
    expect(spotBand(w, { type: 'entity', entity: 'glide' })).toBe('low-sky');
    expect(spotBand(w, { type: 'entity', entity: 'glowmoss-caverns' })).toBe('hollows');
    expect(spotBand(w, { type: 'entity', entity: 'spore-shrine' })).toBe('hollows');
    expect(spotBand(w, { type: 'entity', entity: 'fourth-accessory-slot' })).toBe('hollows'); // inferred: the feat that unlocks it
    expect(bandOf(w, 'hollows')).toBe('hollows');
    expect(bandOf(w, 'ghost')).toBeUndefined();
    expect(
      spotEntities(w, { type: 'selection', entities: ['glide', 'glide', 'ghost', 'spore-shrine'] }),
    ).toEqual(['glide', 'spore-shrine']);
  });

  it('labels and slugs', () => {
    expect(spotLabel(w, cell)).toBe('Low Sky · items');
    expect(spotLabel(w, region)).toBe('Hollows · .00–.30 × .00–.40');
    expect(spotLabel(w, { type: 'entity', entity: 'glide' })).toBe('Glide');
    expect(spotLabel(w, { type: 'selection', entities: ['glide', 'spore-shrine'] })).toBe(
      'Glide + Spore Shrine',
    );
    expect(
      spotLabel(w, { type: 'selection', entities: ['glide', 'spore-shrine', 'reef-ray'] }),
    ).toBe('Glide, Spore Shrine +1');
    expect(spotLabel(w, { type: 'note', note: 'x'.repeat(80), entities: [] })).toHaveLength(58);
    expect(spotSlug(cell)).toBe('low-sky-items');
    expect(spotSlug(region)).toBe('hollows-region');
    expect(spotSlug({ type: 'note', note: 'Glide breaks the Low Sky', entities: [] })).toBe(
      'glide-breaks-the-low-sky',
    );
    expect(spotSlug({ type: 'selection', entities: ['glide', 'reef-ray'] })).toBe('glide-and-1');
  });

  it('checks spots against moves', () => {
    expect(checkSpot(w, cell, 'fill').ok).toBe(true);
    expect(checkSpot(w, cell, 'vary')).toMatchObject({ ok: false, error: { code: 'spot.move' } });
    expect(checkSpot(w, { type: 'cell', band: 'glide', lane: 'items' }, 'fill')).toMatchObject({
      ok: false,
      error: { code: 'spot.band' },
    });
    expect(checkSpot(w, { type: 'entity', entity: 'ghost' }, 'vary')).toMatchObject({
      ok: false,
      error: { code: 'spot.missing' },
    });
    expect(checkSpot(w, { type: 'selection', entities: ['glide'] }, 'alloy')).toMatchObject({
      ok: false,
      error: { code: 'spot.entities', message: 'Alloy needs 2 entities' },
    });
    expect(checkSpot(w, { type: 'note', note: 'x', entities: [] }, 'vary').ok).toBe(false);
    expect(checkSpot(w, { type: 'note', note: 'x', entities: [] }, 'oppose').ok).toBe(true);
    expect(checkSpot(w, { type: 'entity', entity: '' }, 'vary').ok).toBe(false);
    expect(movesFor(w, { type: 'entity', entity: 'glide' })).toEqual([
      'vary',
      'oppose',
      'push',
      'ground',
      'cost',
      'break',
      'name',
    ]);
    expect(movesFor(w, { type: 'selection', entities: ['glide', 'reef-ray'] })).toContain('alloy');
  });

  it('picks a default move and reads the spot from UI state', () => {
    expect(defaultMove(w, cell)).toBe('fill');
    expect(defaultMove(w, { type: 'entity', entity: 'glide' })).toBe('vary');
    expect(defaultMove(w, { type: 'selection', entities: ['glide', 'reef-ray'] })).toBe('alloy');
    expect(
      defaultMove(w, { type: 'selection', entities: ['glide', 'reef-ray', 'spore-shrine'] }),
    ).toBe('vary');
    expect(spotFromUi(w, { spot: cell, selection: ['glide'], focus: null })).toBe(cell);
    expect(spotFromUi(w, { selection: ['glide', 'reef-ray', 'ghost'], focus: null })).toEqual({
      type: 'selection',
      entities: ['glide', 'reef-ray'],
    });
    expect(spotFromUi(w, { selection: ['glide'], focus: 'reef-ray' })).toEqual({
      type: 'entity',
      entity: 'glide',
    });
    expect(spotFromUi(w, { selection: [], focus: 'reef-ray' })).toEqual({
      type: 'entity',
      entity: 'reef-ray',
    });
    expect(spotFromUi(w, { selection: [], focus: 'ghost' })).toBeNull();
    expect(sameSpot(cell, { lane: 'items', band: 'low-sky', type: 'cell' })).toBe(true);
  });
});

describe('spread records and commands', () => {
  it('makes ids that are unique and stable', () => {
    const w = sampleWorld();
    const spot: Spot = { type: 'cell', band: 'low-sky', lane: 'items' };
    const id = newSpreadId(w, spot, NOW);
    expect(id).toBe('20261104-100000-low-sky-items');
    const { world } = spreadIn(w, spot, 'fill', [cand('c1')], id);
    expect(newSpreadId(world, spot, NOW)).toBe(`${id}-2`);
  });

  it('saves, reads and judges', () => {
    const { world, spread } = spreadIn(sampleWorld(), { type: 'entity', entity: 'glide' }, 'vary', [
      cand('c1'),
      cand('c1', { name: 'dupe' }),
      cand('c2'),
    ]);
    expect(spread.candidates.map((c) => c.key)).toEqual(['c1', 'c2']);
    expect(readSpread(world.spreads.s1)).toEqual(spread);
    expect(readSpread(undefined)).toBeNull();
    expect(readSpread({ id: 'x', created: NOW })).toBeNull();
    const j = must(
      applyCommand(world, cmd('spread.judge', { spread: 's1', key: 'c1', verdict: 'keep' }), ctx),
    );
    const s = readSpread(j.world.spreads.s1);
    expect(s?.judgements.c1).toEqual({ verdict: 'keep', at: NOW });
    expect(s && openCandidates(s).map((c) => c.key)).toEqual(['c2']);
    expect(deepEqual(applyPatch(j.world, j.inverse), world)).toBe(true);
    // Errors.
    const bad = (p: Parameters<typeof cmd<'spread.judge'>>[1]) =>
      applyCommand(j.world, cmd('spread.judge', p), ctx);
    expect(bad({ spread: 's1', key: 'c1', verdict: 'keep' })).toMatchObject({
      error: { code: 'spread.judged' },
    });
    expect(bad({ spread: 's1', key: 'c9', verdict: 'keep' })).toMatchObject({
      error: { code: 'spread.no_candidate' },
    });
    expect(bad({ spread: 'nope', key: 'c1', verdict: 'keep' })).toMatchObject({
      error: { code: 'spread.not_found' },
    });
    expect(bad({ spread: 's1', key: 'c2', verdict: 'kill' })).toMatchObject({
      error: { code: 'command.payload' },
    });
  });

  it('judges a record stored without judgements', () => {
    const w = sampleWorld();
    const { judgements: _j, ...bare } = makeSpread({
      id: 'bare',
      now: NOW,
      request: {
        spot: { type: 'entity', entity: 'glide' },
        move: 'vary',
        count: 1,
        axes: AXES,
        ruleIds: [],
      },
      candidates: [cand('c1')],
      status: 'done',
    });
    const put = must(applyCommand(w, cmd('spread.put', { record: bare }), ctx));
    const j = must(
      applyCommand(
        put.world,
        cmd('spread.judge', { spread: 'bare', key: 'c1', verdict: 'keep' }),
        ctx,
      ),
    );
    expect(readSpread(j.world.spreads.bare)?.judgements.c1?.verdict).toBe('keep');
  });

  it('lists spreads and judgements in order', () => {
    let { world } = spreadIn(
      sampleWorld(),
      { type: 'entity', entity: 'glide' },
      'vary',
      [cand('c1'), cand('c2')],
      'a',
    );
    world = spreadIn(world, { type: 'entity', entity: 'glide' }, 'vary', [cand('c1')], 'b').world;
    world = must(
      applyCommand(world, cmd('spread.put', { record: { id: 'junk', created: NOW } }), ctx),
    ).world;
    expect(allSpreads(world).map((s) => s.id)).toEqual(['a', 'b']);
    world = must(
      applyCommands(world, [cmd('spread.judge', { spread: 'b', key: 'c1', verdict: 'keep' })], {
        now: '2026-11-04T10:00:01.000Z',
      }),
    ).world;
    world = must(
      applyCommands(world, [cmd('spread.judge', { spread: 'a', key: 'c2', verdict: 'keep' })], {
        now: '2026-11-04T10:00:02.000Z',
      }),
    ).world;
    expect(allJudgements(world).map((j) => `${j.spread}/${j.key}`)).toEqual(['b/c1', 'a/c2']);
  });
});

describe('triage', () => {
  it('keeps a new candidate as an idea at the spot, as one undo step', () => {
    const { world, spread } = spreadIn(
      sampleWorld(),
      { type: 'cell', band: 'low-sky', lane: 'items' },
      'fill',
      [
        cand('c1', {
          name: 'Glass Lung',
          fields: { subkind: 'accessory', bogus: 1, slot: 7, change: 'Breathe thin air.' },
          attributes: { defense: -5, weight: 2, Bad: 1 },
          relations: [
            { type: 'made_from', target: 'sky-coral' },
            { type: 'made_from', target: 'sky-coral' },
            { type: 'made_from', target: 'ghost' },
            { type: 'lives_in', target: 'low-sky' },
          ],
        }),
      ],
    );
    const t = must(keepCommands(world, spread, 'c1'));
    expect(t.entity).toBe('glass-lung');
    const a = apply(world, t.commands);
    const e = getEntity(a.world, 'glass-lung');
    expect(e).toMatchObject({
      kind: 'item',
      state: 'idea',
      name: 'Glass Lung',
      fields: { subkind: 'accessory', change: 'Breathe thin air.' },
      attributes: { weight: 2 },
      relations: [
        { type: 'made_from', target: 'sky-coral' },
        { type: 'in_band', target: 'low-sky' },
      ],
      origin: { by: 'ai', moment: 'spread', spread: 's1' },
    });
    expect(e?.ai_fields).toEqual(['name', 'identity', 'subkind', 'change']);
    expect(readSpread(a.world.spreads.s1)?.judgements.c1).toMatchObject({
      verdict: 'keep',
      entity: 'glass-lung',
    });
    expect(deepEqual(applyPatch(a.world, a.inverse), world)).toBe(true);
    expect(keepCommands(a.world, readSpread(a.world.spreads.s1) as SpreadData, 'c1')).toMatchObject(
      {
        ok: false,
        error: { code: 'spread.judged' },
      },
    );
  });

  it('places biomes from a region by band and climate', () => {
    const climate = { temperature: { min: 0, max: 0.3 }, moisture: { min: 0, max: 0.4 } };
    const { world, spread } = spreadIn(
      sampleWorld(),
      { type: 'region', band: 'hollows', climate },
      'fill',
      [cand('c1', { kind: 'biome', name: 'Frost Gallery' })],
    );
    const a = apply(world, must(keepCommands(world, spread, 'c1')).commands);
    expect(getEntity(a.world, 'frost-gallery')?.fields).toEqual({ band: 'hollows', climate });
    expect(getEntity(a.world, 'frost-gallery')?.relations).toEqual([]);
  });

  it('applies Ground, Cost and Name to the entity they are about', () => {
    const w0 = sampleWorld();
    const { world, spread } = spreadIn(w0, { type: 'entity', entity: 'cloud-anklet' }, 'ground', [
      cand('c1', {
        about: 'cloud-anklet',
        relations: [
          { type: 'made_from', target: 'sky-coral', note: 'coral is light' },
          { type: 'counters', target: 'reef-ray', note: 'outrun it' },
          ...getEntity(w0, 'cloud-anklet')!.relations,
        ],
      }),
    ]);
    const before = getEntity(world, 'cloud-anklet')!;
    const t = must(keepCommands(world, spread, 'c1'));
    expect(t.entity).toBe('cloud-anklet');
    const a = apply(world, t.commands);
    const after = getEntity(a.world, 'cloud-anklet')!;
    expect(after.relations.length).toBeGreaterThan(before.relations.length);
    expect(after.relations).toContainEqual({
      type: 'counters',
      target: 'reef-ray',
      note: 'outrun it',
    });
    expect(Object.keys(a.world.entities).length).toBe(Object.keys(world.entities).length);
    expect(deepEqual(applyPatch(a.world, a.inverse), world)).toBe(true);

    const named = spreadIn(w0, { type: 'entity', entity: 'glide' }, 'name', [
      cand('c1', { kind: 'capability', name: 'Wingfall' }),
    ]);
    expect(targetOf(named.world, named.spread, named.spread.candidates[0]!)).toBe('glide');
    const n = apply(named.world, must(keepCommands(named.world, named.spread, 'c1')).commands);
    expect(getEntity(n.world, 'glide')).toMatchObject({ name: 'Wingfall' });
    expect(getEntity(n.world, 'glide')?.ai_fields).toContain('name');

    const cost = spreadIn(w0, { type: 'entity', entity: 'cloud-anklet' }, 'cost', [
      cand('c1', {
        about: 'cloud-anklet',
        fields: {
          route: [{ text: 'Find coral', needs: ['sky-coral', 'ghost'] }, { text: 'Carve it' }],
          band: 'x',
        },
      }),
    ]);
    const c = apply(cost.world, must(keepCommands(cost.world, cost.spread, 'c1')).commands);
    expect(getEntity(c.world, 'cloud-anklet')?.fields.route).toEqual([
      { text: 'Find coral', needs: ['sky-coral'] },
      { text: 'Carve it' },
    ]);
  });

  it('keeps a Break finding without touching entities', () => {
    const { world, spread } = spreadIn(
      sampleWorld(),
      { type: 'entity', entity: 'glide' },
      'break',
      [
        cand('c1', {
          kind: null,
          name: 'Infinite glide',
          relations: [{ type: 'pairs_with', target: 'cloud-anklet' }],
        }),
      ],
    );
    expect(candidateRole(world, spread, spread.candidates[0]!)).toBe('finding');
    const a = apply(world, must(keepCommands(world, spread, 'c1')).commands);
    expect(a.world.entities).toBe(world.entities);
    expect(followSpot(a.world, spread, 'c1')).toEqual({
      type: 'note',
      note: 'Infinite glide: It does thing c1.',
      entities: ['cloud-anklet', 'glide'],
    });
  });

  it('kill examples reach the taste block of every AI request (the packer)', () => {
    const { world, spread } = spreadIn(sampleWorld(), { type: 'entity', entity: 'glide' }, 'vary', [
      cand('c1', { name: 'Gilded Feather' }),
    ]);
    const a = apply(world, must(killCommands(world, spread, 'c1', '3')).commands);
    const taste = packContext(a.world, { entities: ['glide'] }).taste;
    expect(taste).toMatch(
      /## Why candidates get killed[\s\S]*- off-tone \(1\): e\.g\. Gilded Feather/,
    );
  });

  it('kills with a reason and counts it; undo takes the count back', () => {
    const { world, spread } = spreadIn(sampleWorld(), { type: 'entity', entity: 'glide' }, 'vary', [
      cand('c1'),
      cand('c2'),
    ]);
    const a = apply(world, must(killCommands(world, spread, 'c1', '3')).commands);
    expect(a.world.taste.reasons.find((r) => r.key === '3')?.count).toBe(1);
    expect(readSpread(a.world.spreads.s1)?.judgements.c1).toEqual({
      verdict: 'kill',
      reason: '3',
      reasonLabel: 'off-tone',
      at: NOW,
    });
    expect(deepEqual(applyPatch(a.world, a.inverse), world)).toBe(true);
    const o = apply(world, must(killCommands(world, spread, 'c2', '0', '  too cute  ')).commands);
    expect(readSpread(o.world.spreads.s1)?.judgements.c2?.note).toBe('too cute');
    expect(killCommands(world, spread, 'c1', '9')).toMatchObject({
      ok: false,
      error: { code: 'taste.no_reason' },
    });
    expect(killCommands(world, spread, 'zz', '1')).toMatchObject({
      ok: false,
      error: { code: 'spread.no_candidate' },
    });
  });

  it('merges marked candidates into one entity', () => {
    const { world, spread } = spreadIn(
      sampleWorld(),
      { type: 'cell', band: 'hollows', lane: 'materials' },
      'fill',
      [
        cand('c1', { kind: 'material', name: 'Echo Salt', fields: { rarity: 'rare' } }),
        cand('c2', {
          kind: 'material',
          name: 'Hush Salt',
          fields: { rarity: 'common', processing: 'boil it' },
          description: 'quiet',
        }),
        cand('c3', { kind: 'creature', name: 'Not a material' }),
        cand('c4', { kind: null, name: 'A finding' }),
      ],
    );
    const t = must(mergeCommands(world, spread, ['c2', 'c1']));
    expect(t.label).toBe('Merge 2 candidates');
    const a = apply(world, t.commands);
    const e = getEntity(a.world, 'hush-salt')!;
    expect(e.fields).toEqual({ rarity: 'common', processing: 'boil it' });
    expect(e.description).toBe(
      'quiet\n\n- Hush Salt: It does thing c2.\n- Echo Salt: It does thing c1.',
    );
    expect(e.relations).toEqual([{ type: 'in_band', target: 'hollows' }]);
    const s = readSpread(a.world.spreads.s1)!;
    expect(s.judgements.c1).toMatchObject({ verdict: 'merge', entity: 'hush-salt' });
    expect(s.judgements.c2).toMatchObject({ verdict: 'merge', entity: 'hush-salt' });
    expect(deepEqual(applyPatch(a.world, a.inverse), world)).toBe(true);
    expect(mergeCommands(world, spread, ['c1'])).toMatchObject({
      error: { code: 'spread.merge_few' },
    });
    expect(mergeCommands(world, spread, ['c1', 'c1'])).toMatchObject({
      error: { code: 'spread.merge_few' },
    });
    expect(mergeCommands(world, spread, ['c1', 'c3'])).toMatchObject({
      error: { code: 'spread.merge_kind' },
    });
    expect(mergeCommands(world, spread, ['c1', 'c4'])).toMatchObject({
      error: { code: 'spread.merge_kind' },
    });
    expect(mergeCommands(a.world, s, ['c1', 'c3'])).toMatchObject({
      error: { code: 'spread.judged' },
    });
  });

  it('property: the inverse of any merge restores exactly the starting state', () => {
    const base = sampleWorld();
    const kinds = ['item', 'material', 'creature'] as const;
    const candArb = fc.record({
      kind: fc.constantFrom(...kinds),
      name: fc.constantFrom('Glass Lung', 'Spore Lantern', 'Ash Coat', 'Lumen Spore', 'Echo'),
      identity: fc.string({ maxLength: 30 }),
      rel: fc.subarray(['sky-coral', 'low-sky', 'reef-ray', 'glide', 'ghost', 'hollows']),
      rarity: fc.option(fc.constantFrom('common', 'rare', 'mythic')),
    });
    fc.assert(
      fc.property(
        fc.array(candArb, { minLength: 2, maxLength: 6 }),
        fc.integer({ min: 0 }),
        (specs, seed) => {
          const kind = specs[0]!.kind;
          const candidates = specs.map((s, i) =>
            cand(`c${i + 1}`, {
              kind,
              name: s.name,
              identity: s.identity,
              fields: s.rarity ? { rarity: s.rarity } : {},
              relations: s.rel.map((t) => ({ type: 'made_from', target: t })),
            }),
          );
          const { world, spread } = spreadIn(
            base,
            { type: 'cell', band: 'low-sky', lane: 'items' },
            'fill',
            candidates,
          );
          const n = 2 + (seed % (candidates.length - 1));
          const keys = candidates.slice(0, n).map((c) => c.key);
          const a = apply(world, must(mergeCommands(world, spread, keys)).commands);
          expect(deepEqual(applyPatch(a.world, a.inverse), world)).toBe(true);
          expect(Object.keys(a.world.entities).length).toBe(Object.keys(world.entities).length + 1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('cleans fields and relations from the AI', () => {
    const w = sampleWorld();
    expect(cleanFields(w, 'biome', { band: 'glide', mood: 'calm' })).toEqual({ mood: 'calm' });
    expect(cleanFields(w, 'biome', { band: 'ghost', ground: null })).toEqual({});
    expect(cleanFields(w, 'biome', { band: 'hollows' })).toEqual({ band: 'hollows' });
    expect(
      cleanRelations(
        w,
        'item',
        [
          { type: 'nope', target: 'glide' },
          { type: 'requires', target: 'glide' },
          { type: 'requires', target: 'x-self' },
        ],
        'x-self',
      ),
    ).toEqual([{ type: 'requires', target: 'glide' }]);
  });

  it('follows a kept candidate, an about candidate, and asks to keep a new one first', () => {
    const { world, spread } = spreadIn(sampleWorld(), { type: 'entity', entity: 'glide' }, 'vary', [
      cand('c1', { kind: 'capability', name: 'Wall Run' }),
    ]);
    expect(followSpot(world, spread, 'c1')).toBeNull();
    expect(followSpot(world, spread, 'zz')).toBeNull();
    const a = apply(world, must(keepCommands(world, spread, 'c1')).commands);
    expect(followSpot(a.world, readSpread(a.world.spreads.s1)!, 'c1')).toEqual({
      type: 'entity',
      entity: 'wall-run',
    });
    const g = spreadIn(sampleWorld(), { type: 'entity', entity: 'glide' }, 'ground', [
      cand('c1', { kind: 'capability' }),
    ]);
    expect(followSpot(g.world, g.spread, 'c1')).toEqual({ type: 'entity', entity: 'glide' });
  });

  it('every candidate the fake gateway gives, for every move, can be kept and killed', async () => {
    const world = sampleWorld();
    const fake = new FakeAiGateway({ getWorld: () => world });
    const spots: Spot[] = [
      { type: 'cell', band: 'low-sky', lane: 'items' },
      {
        type: 'region',
        band: 'hollows',
        climate: { temperature: { min: 0, max: 0.3 }, moisture: { min: 0, max: 0.4 } },
      },
      { type: 'entity', entity: 'cloud-anklet' },
      { type: 'selection', entities: ['glide', 'reef-ray'] },
      { type: 'note', note: 'The sky is too safe', entities: ['low-sky'] },
    ];
    let checked = 0;
    for (const spot of spots)
      for (const move of MOVES) {
        if (!checkSpot(world, spot, move).ok) continue;
        const out = await fake.run('spread', { spot, move, count: 8 });
        if (!out.ok) throw new Error(out.error.message);
        const { world: w, spread } = spreadIn(world, spot, move, out.result.candidates);
        for (const c of spread.candidates) {
          apply(w, must(keepCommands(w, spread, c.key)).commands);
          apply(w, must(killCommands(w, spread, c.key, '1')).commands);
          checked++;
        }
      }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('the fake gateway under Ground and Cost', () => {
  it('every kept Ground or Cost candidate changes its entity (fields or relations)', async () => {
    const world = sampleWorld();
    const fake = new FakeAiGateway({ getWorld: () => world });
    let checked = 0;
    for (const id of ['cloud-anklet', 'glide', 'reef-ray', 'sky-coral'].filter(
      (x) => world.entities[x],
    ))
      for (const move of ['ground', 'cost'] as const) {
        const spot: Spot = { type: 'entity', entity: id };
        if (!checkSpot(world, spot, move).ok) continue;
        const out = await fake.run('spread', { spot, move, count: 6 });
        if (!out.ok) throw new Error(out.error.message);
        const { world: w, spread } = spreadIn(world, spot, move, out.result.candidates);
        for (const c of spread.candidates) {
          const t = must(keepCommands(w, spread, c.key));
          const changes = t.commands.filter((x) => x.type !== 'spread.judge');
          expect(changes.length, `${move} ${id} ${c.key}`).toBeGreaterThan(0);
          const after = apply(w, t.commands).world;
          expect(after.entities[id]).not.toEqual(w.entities[id]);
          checked++;
        }
      }
    expect(checked).toBeGreaterThanOrEqual(12);
  });
});

describe('kept findings as notes', () => {
  it('turns kept Break findings into notes on the entities involved', async () => {
    const { findingNotes } = await import('./findings');
    const { world, spread } = spreadIn(
      sampleWorld(),
      { type: 'cell', band: 'low-sky', lane: 'items' },
      'break',
      [
        cand('c1', {
          kind: null,
          name: 'Glide loop',
          identity: 'Glide resets on every island.',
          relations: [
            { type: 'pairs_with', target: 'glide' },
            { type: 'pairs_with', target: 'ghost' },
          ],
        }),
        cand('c2', { kind: null, name: 'Not kept' }),
      ],
    );
    expect(findingNotes(world)).toEqual([]);
    const a = apply(world, must(keepCommands(world, spread, 'c1')).commands);
    const notes = findingNotes(a.world);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: 's1:c1'.replace(/^/, 'spread:'),
      source: 'ai',
      kind: 'break',
      severity: 'warn',
      text: 'Glide loop: Glide resets on every island.',
      entities: ['glide', 'low-sky'],
    });
    expect(findingNotes(a.world)).toEqual(notes);
    // Kept new entities are not findings.
    const v = spreadIn(sampleWorld(), { type: 'entity', entity: 'glide' }, 'vary', [
      cand('c1', { kind: 'capability' }),
    ]);
    expect(
      findingNotes(apply(v.world, must(keepCommands(v.world, v.spread, 'c1')).commands).world),
    ).toEqual([]);
  });
});
