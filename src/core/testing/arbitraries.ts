import fc from 'fast-check';
import type { Command } from '../commands/registry';
import { ENTITY_KINDS, ENTITY_STATES } from '../model/kinds';
import { DEFAULT_SCHEMA } from '../model/defaults';

/**
 * fast-check arbitraries for property tests. They deliberately produce invalid
 * commands too (unknown ids, wrong kinds, bad values): a command must either be
 * rejected with the world untouched, or applied leaving the world valid.
 */
export function commandArb(ids: readonly string[]): fc.Arbitrary<Command> {
  const id = fc.oneof(fc.constantFrom(...ids), fc.constantFrom('nope', 'new-thing', 'glass-lung'));
  const kind = fc.constantFrom(...ENTITY_KINDS);
  const relType = fc.constantFrom(...Object.keys(DEFAULT_SCHEMA.relations), 'bogus');
  const name = fc.constantFrom('Glass Lung', 'Ember Coat', 'Moss Grazer', 'X', 'Hollow Bell');
  const text = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom('', 'a line', 'Ünïcödé'));
  const fieldKey = fc.constantFrom(
    ...new Set(Object.values(DEFAULT_SCHEMA.kinds).flatMap((k) => k.fields.map((f) => f.key))),
    'not_a_field',
  );
  const fieldValue = fc.oneof(
    text,
    fc.double({ min: -2000, max: 2000, noNaN: true }),
    fc.constantFrom(null, '-inf', '+inf', 'armor', 'weapon', 'common', 'hollows', ['a', 'b'], true),
    fc.record({ min: fc.integer({ min: 0, max: 5 }), max: fc.integer({ min: 0, max: 10 }) }),
    fc.constant({ temperature: { min: 0.1, max: 0.4 }, moisture: { min: 0.2, max: 0.9 } }),
  );
  const c = <T extends Command['type']>(
    type: T,
    payload: fc.Arbitrary<unknown>,
  ): fc.Arbitrary<Command> => payload.map((p) => ({ type, payload: p }) as Command);
  return fc.oneof(
    c('entity.create', fc.record({ kind, name }, { requiredKeys: ['kind', 'name'] })),
    c(
      'entity.create',
      fc.record({
        kind: fc.constant('item'),
        name,
        fields: fc.constant({ subkind: 'armor' }),
        relations: fc.array(fc.record({ type: relType, target: id }), { maxLength: 2 }),
      }),
    ),
    c(
      'entity.update',
      fc.record({
        id,
        set: fc.dictionary(
          fc.oneof(fc.constantFrom('name', 'identity', 'description', 'why', 'tags'), fieldKey),
          fieldValue,
          { maxKeys: 3 },
        ),
        source: fc.constantFrom('user', 'ai'),
      }),
    ),
    c('entity.setField', fc.record({ id, field: fieldKey, value: fieldValue })),
    c('entity.delete', fc.record({ id })),
    c(
      'entity.setState',
      fc.record({
        id,
        state: fc.constantFrom(...ENTITY_STATES),
        why: fc.option(text, { nil: undefined }),
        killed: fc.option(fc.record({ reason: fc.constant('seen it') }), { nil: undefined }),
      }),
    ),
    c(
      'entity.setAttribute',
      fc.record({
        id,
        key: fc.constantFrom('defense', 'damage', 'weight'),
        value: fc.option(fc.double({ min: -10, max: 100, noNaN: true }), { nil: null }),
      }),
    ),
    c('relation.add', fc.record({ from: id, type: relType, to: id })),
    c('relation.remove', fc.record({ from: id, type: relType, to: id })),
    c(
      'numbers.setVariable',
      fc.record({
        name: fc.constantFrom('k', 'base_health', 'tier'),
        value: fc.option(fc.integer(), { nil: null }),
      }),
    ),
    c(
      'spread.put',
      fc.record({
        record: fc.record({
          id: fc.constantFrom('s1', 's2'),
          created: fc.constant('2026-11-01T00:00:00.000Z'),
        }),
      }),
    ),
  );
}

/** Strings a file format can trip on: YAML and JSON specials, line ends, BOMs, odd code points. */
export const awkwardText: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 16 }),
  fc.constantFrom(
    '',
    ' ',
    'yes',
    'null',
    '~',
    '0x10',
    '1e3',
    '- a',
    'a: b',
    '# c',
    '---',
    '---\nx: 1\n---\n',
    'trailing \n\n',
    '\n\nleading',
    'a\r\nb',
    'a\rb',
    '﻿bom',
    'a b',
    'tab\there',
    '"quoted"',
    "'single'",
    '\\back',
    '😀 astral',
  ),
);

/** Numbers a file format can trip on. */
export const awkwardNumber: fc.Arbitrary<number> = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(-0, 0, 1e21, -1e-7, 5e-324, 2 ** 53 + 2, 0.1 + 0.2),
);

/**
 * Every command type carbon has, with payloads that are mostly valid (so they
 * apply) and full of awkward values. `EVERY_COMMAND_TYPE` lists what this
 * reaches; a test checks it is the whole registry, so a new command can't be
 * left out of the store's round-trip property.
 */
export function everyCommandArb(
  ids: readonly string[],
  /** What already exists in the start world, so removes and edits find their target. */
  existing: {
    relations?: readonly { from: string; type: string; to: string }[];
    patterns?: readonly string[];
  } = {},
): fc.Arbitrary<Command> {
  const id = fc.constantFrom(...ids);
  const relType = fc.constantFrom(...Object.keys(DEFAULT_SCHEMA.relations));
  const existingRelation =
    existing.relations && existing.relations.length > 0
      ? fc.oneof(
          fc.constantFrom(...existing.relations),
          fc.record({ from: id, type: relType, to: id }),
        )
      : fc.record({ from: id, type: relType, to: id });
  const patternId = fc.constantFrom(...(existing.patterns ?? []), 'p-1');
  const text = awkwardText;
  const num = awkwardNumber;
  const now = fc.constantFrom('2026-11-05T01:00:00.000Z', '2026-11-06T02:03:04.005Z');
  const c = <T extends Command['type']>(
    type: T,
    payload: fc.Arbitrary<unknown>,
  ): fc.Arbitrary<Command> => payload.map((p) => ({ type, payload: p }) as Command);
  const textField = fc.constantFrom('identity', 'description', 'why', 'name');
  const kind = fc.constantFrom(...ENTITY_KINDS);
  const axis = fc.record({ label: text, low: text, high: text });
  const candidate = fc.record({
    key: fc.constantFrom('c1', 'c2', 'c3'),
    kind: fc.constantFrom('item', 'material', null),
    name: text.filter((s) => s.length > 0),
    identity: text,
    description: text,
    fields: fc.constant({}),
    attributes: fc.dictionary(fc.constantFrom('defense', 'damage'), num, { maxKeys: 2 }),
    relations: fc.constant([]),
    position: fc.record({
      x: fc.double({ min: 0, max: 1, noNaN: true }),
      y: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
    wildcard: fc.boolean(),
  });
  const spread = fc.record({
    id: fc.constantFrom('20261105-010000-cell', 's2'),
    created: now,
    updated: now,
    spot: fc.constant({ type: 'cell', band: 'low-sky', lane: 'items' }),
    move: fc.constantFrom('fill', 'push', 'ground'),
    direction: text.map((s) => s.slice(0, 300)),
    axes: fc.record({ x: axis, y: axis }),
    count: fc.integer({ min: 1, max: 16 }),
    ruleIds: fc.constant([]),
    status: fc.constantFrom('done', 'cancelled', 'failed'),
    candidates: fc.array(candidate, { maxLength: 3 }),
    judgements: fc.constant({}),
    dropped: fc.nat({ max: 5 }),
    costUsd: fc.double({ min: 0, max: 1, noNaN: true }),
    extra: text, // unknown keys are kept
  });
  const curve = fc.record({
    id: fc.constantFrom('ttk', 'defense-budget'),
    y: text,
    over: fc.constantFrom({ axis: 'tier' }, { axis: 'band' }),
    intent: fc.array(fc.record({ x: fc.oneof(num, text), y: num }), { maxLength: 3 }),
  });
  const reasonKey = fc.constantFrom('1', '2', '8', '9');
  const label = text.filter((s) => s.length >= 1 && s.length <= 40);
  const ruleText = text.filter((s) => s.length >= 1 && s.length <= 300);
  return fc.oneof(
    c(
      'entity.create',
      fc.record(
        {
          kind,
          name: text.filter((s) => s.trim() !== ''),
          identity: text,
          description: text,
          why: text,
          tags: fc.array(text, { maxLength: 3 }),
        },
        { requiredKeys: ['kind', 'name'] },
      ),
    ),
    c(
      'entity.update',
      fc.record({
        id,
        set: fc.dictionary(textField, text, { maxKeys: 3 }),
        source: fc.constantFrom('user', 'ai'),
      }),
    ),
    c(
      'entity.update',
      fc.record({ id, set: fc.record({ tags: fc.array(text, { maxLength: 3 }) }) }),
    ),
    c(
      'entity.setField',
      fc.record({
        id,
        field: fc.constantFrom(
          'character',
          'temperament',
          'verb',
          'deed',
          'tradeoff',
          'change',
          'mood',
        ),
        value: text,
      }),
    ),
    c(
      'entity.setField',
      fc.record({ id, field: fc.constantFrom('y_bottom', 'y_top', 'menace'), value: num }),
    ),
    c('entity.delete', fc.record({ id })),
    c(
      'entity.setState',
      fc.record({
        id,
        state: fc.constantFrom(...ENTITY_STATES),
        why: text,
        killed: fc.record({ reason: text, note: text }),
      }),
    ),
    c(
      'entity.setAttribute',
      fc.record({
        id,
        key: fc.constantFrom('defense', 'damage', 'weight'),
        value: fc.option(num, { nil: null }),
      }),
    ),
    c(
      'relation.add',
      fc.record({
        from: id,
        type: fc.constantFrom(...Object.keys(DEFAULT_SCHEMA.relations)),
        to: id,
        note: text,
      }),
    ),
    c('relation.remove', existingRelation),
    c(
      'schema.setKind',
      fc.record({
        kind,
        override: fc.option(fc.record({ label: text, help: text }), { nil: null }),
      }),
    ),
    c(
      'schema.setAttributeDef',
      fc.record({
        kind,
        def: fc.record({
          key: fc.constantFrom('weight', 'heat'),
          label: text,
          min: fc.constant(-1e9),
          max: fc.constant(1e9),
        }),
      }),
    ),
    c(
      'schema.setRelationType',
      fc.record({
        type: fc.constant('echoes'),
        def: fc.option(
          fc.record({
            type: fc.constant('echoes'),
            label: text,
            inverseLabel: text,
            from: fc.constant('*'),
            to: fc.constant('*'),
            symmetric: fc.boolean(),
            acyclic: fc.constant(false),
          }),
          { nil: null },
        ),
      }),
    ),
    c(
      'numbers.setVariable',
      fc.record({
        name: fc.constantFrom('k', 'base_health', 'tier'),
        value: fc.oneof(num, text, fc.boolean(), fc.constant(null)),
      }),
    ),
    c(
      'numbers.setFormulas',
      fc.record({
        source: fc.oneof(
          text,
          fc.constantFrom('k = 100\nx2(v) = v * 2\n', 'k = 1\r\nj = 2\r', '﻿k = 1\n', 'k = 1'),
        ),
      }),
    ),
    c(
      'settings.set',
      fc.record({
        key: fc.constantFrom('name', 'theme', 'x', 'constructor', '__proto__'),
        value: fc.oneof(text, num, fc.record({ a: num, b: text })),
      }),
    ),
    c(
      'taste.set',
      fc.record({
        rules: fc.array(
          fc.record({ id: fc.constantFrom('r1', 'r2'), text, enabled: fc.boolean() }),
          { maxLength: 2 },
        ),
      }),
    ),
    c(
      'spread.put',
      fc.record({
        record: fc.record({ id: fc.constantFrom('p1', 'p2'), created: now, note: text, n: num }),
      }),
    ),
    c('spread.remove', fc.record({ id: fc.constantFrom('p1', 's2', '20261105-010000-cell') })),
    c(
      'placement.pin',
      fc.record({
        id,
        to: fc.option(
          fc.array(fc.constantFrom('low-sky', 'hollows', 'glowmoss-caverns'), {
            minLength: 1,
            maxLength: 2,
          }),
          { nil: undefined },
        ),
      }),
    ),
    c('placement.unpin', fc.record({ id })),
    c('numbers.putCurve', fc.record({ curve })),
    c('numbers.removeCurve', fc.record({ id: fc.constantFrom('ttk', 'defense-budget') })),
    c(
      'numbers.setIntent',
      fc.record({
        id: fc.constantFrom('ttk', 'defense-budget'),
        points: fc.option(fc.array(fc.record({ x: num, y: num }), { maxLength: 3 }), { nil: null }),
      }),
    ),
    c(
      'numbers.removeAttributeDef',
      fc.record({
        kind: fc.oneof(fc.constant('item' as const), kind),
        key: fc.constantFrom('weight', 'heat', 'defense'),
      }),
    ),
    c(
      'numbers.renameVariable',
      fc.record({
        from: fc.constantFrom('k', 'base_health'),
        to: fc.constantFrom('kk', 'health_base'),
      }),
    ),
    c('spread.save', fc.record({ record: spread })),
    c(
      'spread.judge',
      fc.record({
        spread: fc.constantFrom('20261105-010000-cell', 's2'),
        key: fc.constantFrom('c1', 'c2', 'c3'),
        verdict: fc.constantFrom('keep', 'merge', 'kill'),
        reason: fc.constantFrom('1', '2'),
        note: text.map((s) => s.slice(0, 200)),
      }),
    ),
    c('taste.addRule', fc.record({ text: ruleText })),
    c(
      'taste.updateRule',
      fc.record({
        id: fc.constantFrom('r1', 'no-pure-numbers'),
        text: ruleText,
        enabled: fc.boolean(),
      }),
    ),
    c('taste.removeRule', fc.record({ id: fc.constantFrom('r1', 'no-pure-numbers') })),
    c('taste.addReason', fc.record({ key: reasonKey, label })),
    c('taste.updateReason', fc.record({ key: reasonKey, label })),
    c('taste.removeReason', fc.record({ key: reasonKey })),
    c('taste.countReason', fc.record({ key: reasonKey, by: fc.integer({ min: -3, max: 3 }) })),
    c(
      'taste.learnPatterns',
      fc.record({
        patterns: fc.array(
          fc.record({
            text: text.filter((s) => s.length > 0),
            examples: fc.array(text, { maxLength: 2 }),
            strength: fc.double({ min: 0, max: 1, noNaN: true }),
          }),
          { maxLength: 2 },
        ),
        judged: fc.nat({ max: 100 }),
        at: now,
      }),
    ),
    c(
      'taste.setPatternStatus',
      fc.record({
        id: patternId,
        status: fc.constantFrom('proposed', 'promoted', 'dismissed'),
      }),
    ),
  );
}

/** The command types `everyCommandArb` produces. */
export const EVERY_COMMAND_TYPE = [
  'entity.create',
  'entity.update',
  'entity.setField',
  'entity.delete',
  'entity.setState',
  'entity.setAttribute',
  'relation.add',
  'relation.remove',
  'schema.setKind',
  'schema.setAttributeDef',
  'schema.setRelationType',
  'numbers.setVariable',
  'numbers.setFormulas',
  'settings.set',
  'taste.set',
  'spread.put',
  'spread.remove',
  'placement.pin',
  'placement.unpin',
  'numbers.putCurve',
  'numbers.removeCurve',
  'numbers.setIntent',
  'numbers.removeAttributeDef',
  'numbers.renameVariable',
  'spread.save',
  'spread.judge',
  'taste.addRule',
  'taste.updateRule',
  'taste.removeRule',
  'taste.addReason',
  'taste.updateReason',
  'taste.removeReason',
  'taste.countReason',
  'taste.learnPatterns',
  'taste.setPatternStatus',
] as const;
