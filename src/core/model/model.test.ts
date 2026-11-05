import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { COMMANDS, cmd, type CommandType } from '../commands/registry';
import { OffAiGateway } from '../ai/off';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { hashString, hashValue, seededRandom } from '../util/hash';
import { deepEqual, deepFreeze, JsonSchema, stableStringify } from '../util/json';
import { DEFAULT_SCHEMA } from './defaults';
import { EntitySchema, type Entity } from './entity';
import { fieldValueSchema, heightValue, isEmptyValue, type FieldDef } from './fields';
import { slugify, uniqueId } from './ids';
import { canTransition, missingFor, requiredFor } from './lifecycle';
import { resolveSchema, schemaProblems } from './schema';
import { findCycle, kindAllowed, validateWorld } from './validate';
import { entitiesOfKind, getEntity, schemaOf, type World } from './world';

const ent = (over: Partial<Entity> & Pick<Entity, 'id' | 'kind'>): Entity =>
  EntitySchema.parse({ name: over.id, created: SAMPLE_TIME, updated: SAMPLE_TIME, ...over });

describe('ids', () => {
  it('slugifies and de-duplicates deterministically', () => {
    expect(slugify('  Glass Lung!! ')).toBe('glass-lung');
    expect(slugify('Ünïcödé')).toBe('unicode');
    expect(slugify('!!!')).toBe('untitled');
    expect(uniqueId('A b', (id) => ['a-b', 'a-b-2'].includes(id))).toBe('a-b-3');
  });
});

describe('fields', () => {
  const def = (d: Partial<FieldDef> & Pick<FieldDef, 'type'>): FieldDef => ({
    key: 'k',
    label: 'K',
    ...d,
  });
  it('builds a value schema for every field type', () => {
    const cases: [FieldDef, unknown, unknown][] = [
      [def({ type: 'text' }), 'x', 1],
      [def({ type: 'longtext' }), 'x\ny', null],
      [def({ type: 'number', min: 0, max: 1 }), 0.5, 2],
      [def({ type: 'range', min: 0, max: 10 }), { min: 1, max: 2 }, { min: 3, max: 2 }],
      [def({ type: 'enum', options: ['a'] }), 'a', 'b'],
      [def({ type: 'enum' }), 'anything', 3],
      [def({ type: 'list' }), ['a'], 'a'],
      [def({ type: 'height' }), '+inf', 'inf'],
      [def({ type: 'ref' }), 'hollows', 'Not A Slug'],
      [
        def({ type: 'climate' }),
        { temperature: { min: 0, max: 1 }, moisture: { min: 0.2, max: 0.3 } },
        { temperature: { min: 0, max: 2 }, moisture: { min: 0, max: 1 } },
      ],
      [def({ type: 'steps' }), [{ text: 'a', needs: ['x'] }], [{}]],
      [def({ type: 'boolean' }), true, 'yes'],
    ];
    for (const [d, good, bad] of cases) {
      expect(fieldValueSchema(d).safeParse(good).success, `${d.type} good`).toBe(true);
      expect(fieldValueSchema(d).safeParse(bad).success, `${d.type} bad`).toBe(false);
    }
    expect([heightValue('-inf'), heightValue('+inf'), heightValue(3)]).toEqual([
      -Infinity,
      Infinity,
      3,
    ]);
    expect([
      isEmptyValue(undefined),
      isEmptyValue(' '),
      isEmptyValue([]),
      isEmptyValue(0),
      isEmptyValue({}),
    ]).toEqual([true, true, true, false, false]);
  });
});

describe('schema', () => {
  it('merges overrides by key and can remove fields', () => {
    const s = resolveSchema(DEFAULT_SCHEMA, {
      kinds: {
        item: {
          label: 'Thing',
          fields: [
            { key: 'slot', label: 'Slot!', type: 'text' },
            { key: 'weight', label: 'Weight', type: 'number' },
          ],
          removeFields: ['moment'],
          required: { shaped: ['identity'] },
        },
      },
      relations: [
        {
          type: 'echoes',
          label: 'echoes',
          inverseLabel: 'echoed by',
          from: '*',
          to: '*',
          symmetric: false,
          acyclic: false,
        },
      ],
    });
    expect(s.kinds.item.label).toBe('Thing');
    expect(s.kinds.item.fields.find((f) => f.key === 'slot')?.label).toBe('Slot!');
    expect(s.kinds.item.fields.map((f) => f.key)).toContain('weight');
    expect(s.kinds.item.fields.map((f) => f.key)).not.toContain('moment');
    expect(s.kinds.item.required).toEqual({
      idea: ['subkind'],
      shaped: ['identity'],
      decided: ['moment', 'route'],
    });
    expect(s.relations.echoes).toBeDefined();
    expect(s.kinds.band).toBe(DEFAULT_SCHEMA.kinds.band);
    expect(schemaProblems(DEFAULT_SCHEMA)).toEqual([]);
  });

  it('finds unusable schemas', () => {
    const s = resolveSchema(DEFAULT_SCHEMA, {
      kinds: {
        feat: {
          fields: [
            { key: 'why', label: 'Why', type: 'text' },
            { key: 'x', label: 'X', type: 'enum' },
          ],
        },
      },
      relations: [],
    });
    expect(schemaProblems(s)).toEqual([
      'feat.why shadows a common field',
      'feat.x is an enum without options',
    ]);
    const dup = {
      ...s,
      kinds: {
        ...s.kinds,
        feat: {
          ...s.kinds.feat,
          fields: [...DEFAULT_SCHEMA.kinds.feat.fields, DEFAULT_SCHEMA.kinds.feat.fields[0]!],
        },
      },
    };
    expect(schemaProblems(dup)).toEqual(['feat.deed is defined twice']);
  });
});

describe('lifecycle', () => {
  const schema = DEFAULT_SCHEMA;
  it('accumulates requirements up the ladder', () => {
    expect(requiredFor(schema, { kind: 'item' }, 'idea')).toEqual(['subkind']);
    expect(requiredFor(schema, { kind: 'item' }, 'shaped')).toEqual([
      'subkind',
      'identity',
      'change',
      'tradeoff',
    ]);
    expect(requiredFor(schema, { kind: 'item' }, 'exported')).toEqual([
      'subkind',
      'identity',
      'change',
      'tradeoff',
      'moment',
      'route',
      'why',
    ]);
    expect(requiredFor(schema, { kind: 'item' }, 'graveyard')).toEqual([]);
    const lantern = sampleWorld().entities['spore-lantern']!;
    expect(missingFor(schema, lantern, 'decided')).toEqual(['moment', 'why']);
    expect(missingFor(schema, { ...lantern, description: 'x', tags: ['a'] }, 'shaped')).toEqual([]);
    expect(canTransition('decided', 'graveyard')).toBe(false);
    expect(canTransition('exported', 'decided')).toBe(true);
  });
});

describe('validation', () => {
  const world = (...es: Entity[]): World => ({
    ...sampleWorld(),
    entities: Object.fromEntries(es.map((e) => [e.id, e])),
  });

  it('flags bad fields, attributes, relations and refs', () => {
    const w = world(
      ent({ id: 'b', kind: 'band' }),
      ent({
        id: 'i',
        kind: 'item',
        fields: { subkind: 'hat', wings: 2 },
        attributes: { defense: -1 },
        relations: [
          { type: 'nope', target: 'b' },
          { type: 'made_from', target: 'b' },
          { type: 'made_from', target: 'b' },
          { type: 'pairs_with', target: 'i' },
          { type: 'pairs_with', target: 'b' },
          { type: 'requires', target: 'ghost' },
          { type: 'drops', target: 'b' },
        ],
      }),
      ent({ id: 'bi', kind: 'biome', fields: { band: 'i' } }),
      ent({ id: 'bj', kind: 'biome', fields: { band: 'ghost' } }),
    );
    const codes = validateWorld(w).map((p) => `${p.entity}:${p.code}`);
    expect(codes).toEqual([
      'i:field.invalid',
      'i:field.unknown',
      'i:attribute.range',
      'i:relation.unknown_type',
      'i:relation.target_kind',
      'i:relation.duplicate',
      'i:relation.target_kind',
      'i:relation.self',
      'i:relation.asymmetric',
      'i:relation.dangling',
      'i:relation.source_kind',
      'i:relation.target_kind',
      'bi:ref.kind',
      'bj:ref.dangling',
    ]);
    expect(
      validateWorld({ ...w, entities: { x: ent({ id: 'y', kind: 'feat' }) } }).map((p) => p.code),
    ).toEqual(['entity.key']);
    expect(
      validateWorld({ ...w, entities: { y: { ...ent({ id: 'y', kind: 'feat' }), name: '' } } }).map(
        (p) => p.code,
      ),
    ).toEqual(['entity.shape']);
  });

  it('finds cycles of acyclic relations', () => {
    const w = world(
      ent({ id: 'a', kind: 'item', relations: [{ type: 'supersedes', target: 'b' }] }),
      ent({ id: 'b', kind: 'item', relations: [{ type: 'supersedes', target: 'c' }] }),
      ent({ id: 'c', kind: 'item', relations: [{ type: 'supersedes', target: 'a' }] }),
      ent({ id: 'd', kind: 'item', relations: [{ type: 'supersedes', target: 'a' }] }),
    );
    const def = DEFAULT_SCHEMA.relations.supersedes!;
    expect(findCycle(w, def, 'a')).toEqual(['a', 'b', 'c']);
    expect(findCycle(w, def, 'd')).toBeNull();
    expect(
      validateWorld(w)
        .filter((p) => p.code === 'relation.cycle')
        .map((p) => p.entity),
    ).toEqual(['a', 'b', 'c']);
    expect(kindAllowed('*', 'band')).toBe(true);
  });

  it('reads the world', () => {
    const w = sampleWorld();
    expect(entitiesOfKind(w, 'band').map((b) => b.id)).toEqual([
      'groundline',
      'high-drift',
      'hollows',
      'low-sky',
      'undercroft',
    ]);
    expect(getEntity(w, 'toString')).toBeUndefined();
    expect(schemaOf(w)).toBe(schemaOf(w));
  });
});

describe('command labels', () => {
  it('every command has a readable label', () => {
    const w = sampleWorld();
    const payloads: Record<CommandType, unknown> = {
      'entity.create': { kind: 'feat', name: 'Leap' },
      'entity.update': { id: 'glide', set: {} },
      'entity.setField': { id: 'glide', field: 'verb', value: 'x' },
      'entity.delete': { id: 'glide' },
      'entity.setState': { id: 'glide', state: 'exported' },
      'entity.setAttribute': { id: 'glide', key: 'x', value: 1 },
      'relation.add': { from: 'glide', type: 'requires', to: 'spore-lantern' },
      'relation.remove': { from: 'ghost', type: 'requires', to: 'ghost2' },
      'schema.setKind': { kind: 'item', override: null },
      'schema.setAttributeDef': { kind: 'item', def: { key: 'w' } },
      'schema.setRelationType': { type: 'x', def: null },
      'numbers.setVariable': { name: 'k', value: 1 },
      'numbers.setFormulas': { source: '' },
      'settings.set': { key: 'name', value: 'x' },
      'taste.set': { reasons: [], patterns: [] },
      'spread.put': { record: { id: 's', created: SAMPLE_TIME } },
      'spread.remove': { id: 's' },
      'placement.pin': { id: 'glide' },
      'placement.unpin': { id: 'glide' },
      'numbers.putCurve': { curve: { id: 'c', y: 'x', over: { axis: 'tier' } } },
      'numbers.removeCurve': { id: 'c' },
      'numbers.setIntent': { id: 'c', points: null },
      'numbers.removeAttributeDef': { kind: 'item', key: 'w' },
      'numbers.renameVariable': { from: 'k', to: 'kk' },
      // W5 (spreads): spread and taste commands.
      'spread.save': {
        record: {
          id: 's',
          created: SAMPLE_TIME,
          updated: SAMPLE_TIME,
          spot: { type: 'entity', entity: 'glide' },
          move: 'vary',
          axes: { x: { label: 'a', low: 'l', high: 'h' }, y: { label: 'b', low: 'l', high: 'h' } },
          count: 1,
          candidates: [],
        },
      },
      'spread.judge': { spread: 's', key: 'c1', verdict: 'keep' },
      // images-core: image and art commands.
      'image.add': {
        image: {
          id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
          entity: 'glide',
          kind: 'concept',
          origin: { by: 'fake', prompt: 'p', size: '1024x1024' },
          created: SAMPLE_TIME,
          hashes: { output: 'a'.repeat(64) },
        },
      },
      'image.select': { entity: 'glide', image: '01JAAAAAAAAAAAAAAAAAAAAAAA' },
      'image.unselect': { entity: 'glide', kind: 'icon' },
      'image.remove': { entity: 'glide', image: '01JAAAAAAAAAAAAAAAAAAAAAAA' },
      'art.set': { direction: 'painterly' },
      'taste.addRule': { text: 'No filler.' },
      'taste.updateRule': { id: 'no-pure-numbers', enabled: false },
      'taste.removeRule': { id: 'no-pure-numbers' },
      'taste.addReason': { key: '8', label: 'too cute' },
      'taste.updateReason': { key: '1', label: 'numbers' },
      'taste.removeReason': { key: '1' },
      'taste.countReason': { key: '1', by: 1 },
      'taste.learnPatterns': { patterns: [], judged: 0, at: SAMPLE_TIME },
      'taste.setPatternStatus': { id: 'p', status: 'promoted' },
    };
    for (const [type, def] of Object.entries(COMMANDS)) {
      const label = def.label(def.payload.parse(payloads[type as CommandType]) as never, w);
      expect(label.length, type).toBeGreaterThan(2);
    }
  });

  it('removes settings, taste lists and missing-entity failures', () => {
    const ctx = { now: SAMPLE_TIME };
    const r = applyCommand(sampleWorld(), cmd('taste.set', { reasons: [], patterns: [] }), ctx);
    expect(r.ok && r.value.world.taste.reasons).toEqual([]);
    for (const c of [
      cmd('entity.setState', { id: 'ghost', state: 'idea' }),
      cmd('entity.setAttribute', { id: 'ghost', key: 'x', value: 1 }),
      cmd('entity.setField', { id: 'ghost', field: 'x', value: 1 }),
      cmd('relation.add', { from: 'ghost', type: 'requires', to: 'glide' }),
      cmd('relation.remove', { from: 'ghost', type: 'requires', to: 'glide' }),
    ])
      expect(applyCommand(sampleWorld(), c, ctx)).toMatchObject({
        ok: false,
        error: { code: 'entity.not_found' },
      });
    const set = applyCommand(sampleWorld(), cmd('settings.set', { key: 'extra', value: 1 }), ctx);
    if (!set.ok) throw new Error('setup');
    const removed = applyCommand(
      set.value.world,
      cmd('settings.set', { key: 'extra', value: undefined }),
      ctx,
    );
    expect(removed.ok && 'extra' in removed.value.world.settings).toBe(false);
    const exported = applyCommand(
      sampleWorld(),
      cmd('entity.setAttribute', { id: 'cinder-sting', key: 'damage', value: 13 }),
      ctx,
    );
    expect(exported.ok && exported.value.world.entities['cinder-sting']?.state).toBe('decided');
  });
});

describe('util', () => {
  it('compares, canonicalises, hashes and freezes', () => {
    expect(deepEqual({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(stableStringify({ b: 1, a: [{ d: 1, c: undefined }] })).toBe('{"a":[{"d":1}],"b":1}');
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    expect(hashString('a')).not.toBe(hashString('b'));
    expect(hashString('')).toMatch(/^[0-9a-f]{16}$/);
    const r1 = seededRandom('x');
    const r2 = seededRandom('x');
    expect([r1(), r1()]).toEqual([r2(), r2()]);
    expect(Object.isFrozen(deepFreeze({ a: { b: 1 } }).a)).toBe(true);
    expect(JsonSchema.safeParse({ a: [1, 'x', null, true] }).success).toBe(true);
    expect(JsonSchema.safeParse({ a: () => 1 }).success).toBe(false);
  });

  it('OffAiGateway is always off and says why', async () => {
    const g = new OffAiGateway('no key');
    expect(g.status()).toMatchObject({ mode: 'off', enabled: false, reason: 'no key' });
    g.setEnabled();
    g.onStatus()();
    expect(await g.log()).toEqual([]);
    expect(await g.run()).toMatchObject({
      ok: false,
      error: { code: 'disabled', message: 'no key' },
    });
  });
});
