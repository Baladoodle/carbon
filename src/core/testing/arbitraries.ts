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
