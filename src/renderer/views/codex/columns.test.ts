import { describe, expect, it } from 'vitest';
import { applyCommands } from '@core/commands/apply';
import { schemaOf, type World } from '@core/model/world';
import { resolvePlacement } from '@core/placement';
import { sampleWorld } from '@core/testing/sample';
import {
  columnsFor,
  commandForEdit,
  draftOf,
  formatField,
  needsWhy,
  planBulkState,
  sortEntities,
  type CellEdit,
} from './columns';

const world = sampleWorld();
const schema = schemaOf(world);
const ctx = { world, placements: resolvePlacement(world) };
const E = (id: string) => {
  const e = world.entities[id];
  if (!e) throw new Error(id);
  return e;
};
const col = (tab: Parameters<typeof columnsFor>[0], id: string) => {
  const c = columnsFor(tab, schema).find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};

describe('columnsFor', () => {
  it('drives columns from the schema', () => {
    expect(columnsFor('all', schema).map((c) => c.id)).toEqual([
      'name',
      'kind',
      'identity',
      'band',
    ]);
    expect(columnsFor('item', schema).map((c) => c.id)).toEqual([
      'name',
      'identity',
      'band',
      'f:subkind',
      'f:slot',
      'f:change',
      'f:tradeoff',
      'f:moment',
      'f:route',
      'a:defense',
      'a:damage',
    ]);
    expect(columnsFor('band', schema).map((c) => c.id)).not.toContain('band');
    expect(columnsFor('biome', schema).map((c) => c.id)).not.toContain('f:band');
    const w2: World = {
      ...world,
      schema: {
        kinds: { item: { fields: [{ key: 'weight', label: 'Weight', type: 'number' }] } },
        relations: [],
      },
    };
    expect(columnsFor('item', schemaOf(w2)).map((c) => c.id)).toContain('f:weight');
  });

  it('reads cells for every field type', () => {
    expect(col('band', 'f:y_bottom').text(E('undercroft'), ctx)).toBe('−∞');
    expect(col('band', 'f:y_top').text(E('high-drift'), ctx)).toBe('+∞');
    expect(col('band', 'f:danger').text(E('hollows'), ctx)).toBe('3–6');
    expect(col('material', 'f:properties').text(E('lumen-spore'), ctx)).toBe('glows, fragile');
    expect(col('creature', 'f:menace').text(E('moss-grazer'), ctx)).toBe('-0.6');
    expect(col('biome', 'f:climate').text(E('ash-vents'), ctx)).toBe('0.75–1.00 × 0.00–0.25');
    expect(col('item', 'f:route').text(E('spore-lantern'), ctx)).toBe(
      'gather lumen spores → press at a spore shrine',
    );
    expect(col('item', 'a:damage').text(E('cinder-sting'), ctx)).toBe('12');
    expect(col('item', 'a:damage').text(E('spore-lantern'), ctx)).toBe('');
    expect(col('item', 'band').text(E('vent-glass-visor'), ctx)).toBe('Hollows');
    expect(col('item', 'band').dim?.(E('vent-glass-visor'), ctx)).toBe(true);
    expect(col('item', 'band').dim?.(E('spore-lantern'), ctx)).toBe(false);
    expect(col('all', 'kind').text(E('glide'), ctx)).toBe('Capability');
    expect(formatField({ key: 'b', label: 'B', type: 'boolean' }, true, world)).toBe('✓');
    expect(formatField({ key: 'b', label: 'B', type: 'ref' }, 'hollows', world)).toBe('Hollows');
    expect(formatField({ key: 'b', label: 'B', type: 'ref' }, 'gone', world)).toBe('gone');
    expect(formatField({ key: 'b', label: 'B', type: 'longtext' }, '\n first\nsecond', world)).toBe(
      ' first',
    );
    expect(formatField({ key: 'b', label: 'B', type: 'number' }, 1.23456, world)).toBe('1.23');
    expect(formatField({ key: 'b', label: 'B', type: 'range' }, 'x', world)).toBe('');
    expect(formatField({ key: 'b', label: 'B', type: 'climate' }, {}, world)).toBe('');
    expect(formatField({ key: 'b', label: 'B', type: 'text' }, undefined, world)).toBe('');
  });
});

describe('sortEntities', () => {
  const items = Object.values(world.entities).filter((e) => e.kind === 'band');
  it('sorts numbers numerically with empty values last', () => {
    const c = col('band', 'f:y_bottom');
    expect(sortEntities(items, c, 'asc', ctx).map((e) => e.id)).toEqual([
      'undercroft',
      'hollows',
      'groundline',
      'low-sky',
      'high-drift',
    ]);
    expect(sortEntities(items, c, 'desc', ctx).map((e) => e.id)[0]).toBe('high-drift');
    const d = col('band', 'f:danger');
    expect(sortEntities(items, d, 'desc', ctx).map((e) => e.id)).toEqual([
      'undercroft',
      'hollows',
      'low-sky',
      'groundline',
      'high-drift',
    ]);
    expect(sortEntities(items, d, 'asc', ctx).at(-1)?.id).toBe('high-drift');
  });

  it('sorts enums by option order and text case-insensitively, ties by name', () => {
    const mats = Object.values(world.entities).filter((e) => e.kind === 'material');
    expect(sortEntities(mats, col('material', 'f:rarity'), 'asc', ctx).map((e) => e.id)).toEqual([
      'lumen-spore',
      'vent-glass',
      'sky-coral',
    ]);
    expect(sortEntities(mats, undefined, 'asc', ctx).map((e) => e.name)).toEqual([
      'Lumen Spore',
      'Sky Coral',
      'Vent Glass',
    ]);
    const all = Object.values(world.entities);
    const byBand = sortEntities(all, col('all', 'band'), 'asc', ctx);
    expect(byBand[0]?.id).toBe('undercroft');
    expect(byBand.at(-1)?.id).toMatch(/cinder-sting|cloud-anklet|sky-coral/);
  });
});

describe('inline edits', () => {
  const run = (edit: CellEdit, id: string, draft: string) => {
    const c = commandForEdit(edit, E(id), draft);
    if (!c.ok) return { error: c.error.message };
    const r = applyCommands(world, [c.value], { now: '2026-11-04T10:00:00.000Z' });
    return r.ok ? r.value.world.entities[id] : { error: r.error.code };
  };

  it('turns drafts into commands the world accepts', () => {
    expect(run({ type: 'text', key: 'name' }, 'glide', ' Soar ')).toMatchObject({ name: 'Soar' });
    expect(run({ type: 'text', key: 'name' }, 'glide', ' ')).toEqual({ error: 'a name is needed' });
    expect(run({ type: 'text', key: 'identity' }, 'glide', '')).toMatchObject({ identity: '' });
    expect(run({ type: 'text', key: 'verb' }, 'glide', 'soar')).toMatchObject({
      fields: { verb: 'soar' },
    });
    expect(
      run({ type: 'number', key: 'menace', min: -1, max: 1 }, 'moss-grazer', '0.5'),
    ).toMatchObject({
      fields: { menace: 0.5 },
    });
    expect(run({ type: 'number', key: 'menace', min: -1, max: 1 }, 'moss-grazer', '2')).toEqual({
      error: 'at most 1',
    });
    expect(run({ type: 'number', key: 'menace', min: -1 }, 'moss-grazer', '-2')).toEqual({
      error: 'at least -1',
    });
    expect(run({ type: 'number', key: 'menace' }, 'moss-grazer', 'lots')).toEqual({
      error: 'a number',
    });
    expect(run({ type: 'number', key: 'menace' }, 'moss-grazer', '')).not.toHaveProperty(
      'fields.menace',
    );
    expect(run({ type: 'range', key: 'danger' }, 'hollows', '2..7')).toMatchObject({
      fields: { danger: { min: 2, max: 7 } },
    });
    expect(run({ type: 'range', key: 'danger' }, 'hollows', '4')).toMatchObject({
      fields: { danger: { min: 4, max: 4 } },
    });
    expect(run({ type: 'range', key: 'danger' }, 'hollows', '7..2')).toEqual({
      error: 'the low end comes first',
    });
    expect(run({ type: 'range', key: 'danger' }, 'hollows', 'x')).toEqual({
      error: 'a range like 2..5',
    });
    expect(run({ type: 'height', key: 'y_top' }, 'high-drift', '∞')).toMatchObject({
      fields: { y_top: '+inf' },
    });
    expect(run({ type: 'height', key: 'y_bottom' }, 'undercroft', '-inf')).toMatchObject({
      fields: { y_bottom: '-inf' },
    });
    expect(run({ type: 'height', key: 'y_top' }, 'groundline', '128')).toMatchObject({
      fields: { y_top: 128 },
    });
    expect(run({ type: 'height', key: 'y_top' }, 'groundline', 'up')).toEqual({
      error: 'a height, or -inf / +inf',
    });
    expect(run({ type: 'list', key: 'properties' }, 'lumen-spore', 'a, b,,c ')).toMatchObject({
      fields: { properties: ['a', 'b', 'c'] },
    });
    expect(
      run({ type: 'enum', key: 'rarity', options: ['common', 'rare'] }, 'sky-coral', 'gold'),
    ).toEqual({
      error: 'one of common, rare',
    });
    expect(
      run({ type: 'enum', key: 'rarity', options: ['common', 'rare'] }, 'sky-coral', 'common'),
    ).toMatchObject({
      fields: { rarity: 'common' },
    });
    expect(
      run({ type: 'ref', key: 'band', refKinds: ['band'] }, 'cloud-reef', 'hollows'),
    ).toMatchObject({
      fields: { band: 'hollows' },
    });
    expect(run({ type: 'attribute', key: 'damage' }, 'cinder-sting', '15')).toMatchObject({
      attributes: { damage: 15 },
    });
    expect(run({ type: 'attribute', key: 'damage' }, 'cinder-sting', '')).toMatchObject({
      attributes: {},
    });
    expect(run({ type: 'attribute', key: 'damage' }, 'cinder-sting', 'big')).toEqual({
      error: 'a number',
    });
    const b = commandForEdit({ type: 'boolean', key: 'x' }, E('glide'), '');
    expect(b.ok && b.value.payload).toMatchObject({ field: 'x', value: true });
  });

  it('starts drafts from the current value', () => {
    expect(draftOf({ type: 'range', key: 'danger' }, E('hollows'))).toBe('3..6');
    expect(draftOf({ type: 'list', key: 'properties' }, E('lumen-spore'))).toBe('glows, fragile');
    expect(draftOf({ type: 'height', key: 'y_bottom' }, E('undercroft'))).toBe('-inf');
    expect(draftOf({ type: 'attribute', key: 'defense' }, E('vent-glass-visor'))).toBe('4');
    expect(draftOf({ type: 'text', key: 'name' }, E('glide'))).toBe('Glide');
    expect(draftOf({ type: 'number', key: 'menace' }, E('glide'))).toBe('');
  });
});

describe('planBulkState', () => {
  it('moves what can move in one transaction and explains the rest', () => {
    const ids = ['vent-glass', 'sky-coral', 'lumen-spore', 'glide', 'ghost'];
    const plan = planBulkState(world, schema, ids, 'shaped');
    expect(plan.commands.map((c) => c.payload)).toEqual([{ id: 'vent-glass', state: 'shaped' }]);
    expect(plan.skipped).toEqual([
      { id: 'sky-coral', reason: 'needs properties' },
      { id: 'lumen-spore', reason: 'already shaped' },
      { id: 'glide', reason: "can't go from decided to shaped" },
      { id: 'ghost', reason: 'no longer exists' },
    ]);
    const r = applyCommands(world, plan.commands, { now: '2026-11-04T10:00:00.000Z' });
    expect(r.ok).toBe(true);
  });

  it('fills a missing Why when deciding, and needs a kill reason for the graveyard', () => {
    expect(needsWhy(world, ['lumen-spore'])).toBe(true);
    expect(needsWhy(world, ['glide', 'vent-glass'])).toBe(false);
    const decided = planBulkState(world, schema, ['lumen-spore', 'moss-grazer'], 'decided', {
      why: ' Core. ',
    });
    expect(decided.commands.map((c) => c.payload)).toEqual([
      { id: 'lumen-spore', state: 'decided', why: 'Core.' },
      { id: 'moss-grazer', state: 'decided', why: 'Core.' },
    ]);
    expect(applyCommands(world, decided.commands, { now: '2026-11-04T10:00:00.000Z' }).ok).toBe(
      true,
    );
    expect(planBulkState(world, schema, ['lumen-spore'], 'decided').skipped[0]?.reason).toBe(
      'needs why',
    );
    expect(planBulkState(world, schema, ['vent-glass'], 'graveyard').skipped[0]?.reason).toBe(
      'needs a kill reason',
    );
    const killed = planBulkState(world, schema, ['vent-glass', 'sky-coral'], 'graveyard', {
      killed: { reason: 'seen it' },
    });
    expect(killed.commands).toHaveLength(2);
    expect(applyCommands(world, killed.commands, { now: '2026-11-04T10:00:00.000Z' }).ok).toBe(
      true,
    );
  });
});
