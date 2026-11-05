import { describe, expect, it } from 'vitest';
import { schemaOf } from '@core/model/world';
import { sampleWorld } from '@core/testing/sample';
import { neededKeys, splitFields } from './optional';

describe('the Bench shows filled and needed fields, and collapses the rest', () => {
  const world = sampleWorld();
  const schema = schemaOf(world);
  const lantern = world.entities['spore-lantern']!;
  const keys = [...schema.kinds.item.fields.map((f) => f.key), 'description', 'tags', 'why'];

  it('needs the current and the next state’s fields', () => {
    // A shaped item: shaped needs subkind, identity, change, trade-off; decided adds moment, route, why.
    const needed = neededKeys(schema, { ...lantern, state: 'shaped' });
    for (const k of ['subkind', 'change', 'tradeoff', 'moment', 'route', 'why'])
      expect(needed).toContain(k);
    expect(needed).not.toContain('slot');
  });

  it('hides empty optional fields, keeps filled ones, and keeps what the caller asks for', () => {
    const e = { ...lantern, state: 'idea' as const, description: '', tags: [], why: '' };
    const { shown, hidden } = splitFields(schema, e, keys);
    expect(hidden).toEqual(expect.arrayContaining(['slot', 'description', 'tags', 'why']));
    expect(shown).toContain('subkind');
    expect(shown).not.toContain('slot');
    expect(splitFields(schema, e, keys, new Set(['slot'])).shown).toContain('slot');
    const filled = splitFields(schema, { ...e, description: 'Some words.' }, keys);
    expect(filled.shown).toContain('description');
    // Order is kept.
    expect([...shown, ...hidden].sort()).toEqual([...keys].sort());
  });

  it('a graveyard entity needs what an idea needs, so reviving it is one step', () => {
    const needed = neededKeys(schema, { ...lantern, state: 'graveyard' });
    expect([...needed]).toEqual(['subkind']);
  });
});
