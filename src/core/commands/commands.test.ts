import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { errorsOnly, validateWorld } from '../model/validate';
import { getEntity, type World } from '../model/world';
import { commandArb } from '../testing/arbitraries';
import { sampleWorld } from '../testing/sample';
import { deepFreeze } from '../util/json';
import { applyCommand, applyCommands, labelOf } from './apply';
import { applyPatch } from './patch';
import { cmd, type Command } from './registry';

const ctx = { now: '2026-11-04T10:00:00.000Z' };
const base = (): World => deepFreeze(sampleWorld());
const ok = (w: World, c: Command): World => {
  const r = applyCommand(w, c, ctx);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.world;
};
const fail = (w: World, c: Command): string => {
  const r = applyCommand(w, c, ctx);
  if (r.ok) throw new Error('expected failure');
  return r.error.code;
};

describe('sample world', () => {
  it('is valid, with no warnings either', () => {
    expect(validateWorld(sampleWorld())).toEqual([]);
  });
});

describe('entity commands', () => {
  it('creates with a unique slug, kind defaults and timestamps', () => {
    let w = ok(base(), cmd('entity.create', { kind: 'biome', name: 'Glowmoss Caverns' }));
    const e = getEntity(w, 'glowmoss-caverns-2');
    expect(e?.state).toBe('idea');
    expect(e?.fields.climate).toEqual({
      temperature: { min: 0.4, max: 0.6 },
      moisture: { min: 0.4, max: 0.6 },
    });
    expect(e?.created).toBe(ctx.now);
    w = ok(
      w,
      cmd('entity.create', {
        kind: 'item',
        name: 'Glass Lung',
        id: 'glass-lung',
        fields: { subkind: 'armor' },
      }),
    );
    expect(fail(w, cmd('entity.create', { kind: 'item', name: 'Again', id: 'glass-lung' }))).toBe(
      'entity.exists',
    );
  });

  it('rejects invalid kind fields and relations on create', () => {
    expect(
      fail(base(), cmd('entity.create', { kind: 'item', name: 'X', fields: { subkind: 'hat' } })),
    ).toBe('world.invalid');
    expect(
      fail(
        base(),
        cmd('entity.create', {
          kind: 'item',
          name: 'X',
          relations: [{ type: 'made_from', target: 'hollows' }],
        }),
      ),
    ).toBe('world.invalid');
  });

  it('mirrors symmetric relations on create, add and remove', () => {
    let w = ok(
      base(),
      cmd('entity.create', {
        kind: 'item',
        name: 'Pair',
        relations: [{ type: 'pairs_with', target: 'glide' }],
      }),
    );
    expect(getEntity(w, 'glide')?.relations).toContainEqual({ type: 'pairs_with', target: 'pair' });
    w = ok(w, cmd('relation.add', { from: 'pair', type: 'conflicts', to: 'cinder-sting' }));
    expect(getEntity(w, 'cinder-sting')?.relations).toContainEqual({
      type: 'conflicts',
      target: 'pair',
    });
    w = ok(w, cmd('relation.remove', { from: 'cinder-sting', type: 'conflicts', to: 'pair' }));
    expect(getEntity(w, 'pair')?.relations.some((r) => r.type === 'conflicts')).toBe(false);
    expect(validateWorld(w)).toEqual([]);
  });

  it('enforces relation rules', () => {
    const w = base();
    expect(
      fail(w, cmd('relation.add', { from: 'lumen-spore', type: 'made_from', to: 'vent-glass' })),
    ).toBe('world.invalid');
    expect(fail(w, cmd('relation.add', { from: 'spore-lantern', type: 'nope', to: 'glide' }))).toBe(
      'relation.unknown_type',
    );
    expect(
      fail(w, cmd('relation.add', { from: 'spore-lantern', type: 'made_from', to: 'lumen-spore' })),
    ).toBe('relation.exists');
    expect(
      fail(w, cmd('relation.add', { from: 'spore-lantern', type: 'made_from', to: 'nowhere' })),
    ).toBe('entity.not_found');
    expect(
      fail(
        w,
        cmd('relation.add', { from: 'spore-lantern', type: 'pairs_with', to: 'spore-lantern' }),
      ),
    ).toBe('world.invalid');
    // cloud-anklet supersedes spore-lantern; the reverse would be a cycle.
    expect(
      fail(
        w,
        cmd('relation.add', { from: 'spore-lantern', type: 'supersedes', to: 'cloud-anklet' }),
      ),
    ).toBe('world.invalid');
    expect(
      fail(w, cmd('relation.remove', { from: 'spore-lantern', type: 'pairs_with', to: 'glide' })),
    ).toBe('relation.not_found');
  });

  it('updates fields, tracks ai markers, and sends exported entities back to decided', () => {
    let w = ok(
      base(),
      cmd('entity.update', {
        id: 'cinder-sting',
        set: { tradeoff: 'burns your hand' },
        source: 'ai',
      }),
    );
    let e = getEntity(w, 'cinder-sting');
    expect(e?.fields.tradeoff).toBe('burns your hand');
    expect(e?.ai_fields).toEqual(['tradeoff']);
    expect(e?.state).toBe('decided');
    w = ok(w, cmd('entity.setField', { id: 'cinder-sting', field: 'tradeoff', value: 'mine now' }));
    e = getEntity(w, 'cinder-sting');
    expect(e?.ai_fields).toEqual([]);
    w = ok(
      w,
      cmd('entity.update', {
        id: 'cinder-sting',
        set: { slot: null, identity: null, tags: ['hot'] },
      }),
    );
    e = getEntity(w, 'cinder-sting');
    expect(e?.identity).toBe('');
    expect(e?.tags).toEqual(['hot']);
    expect(fail(w, cmd('entity.update', { id: 'cinder-sting', set: { name: '  ' } }))).toBe(
      'field.invalid',
    );
    expect(fail(w, cmd('entity.update', { id: 'cinder-sting', set: { wings: 2 } }))).toBe(
      'field.unknown',
    );
    expect(fail(w, cmd('entity.update', { id: 'cinder-sting', set: { tags: 'x' } }))).toBe(
      'field.invalid',
    );
    expect(fail(w, cmd('entity.update', { id: 'cinder-sting', set: { why: 3 } }))).toBe(
      'field.invalid',
    );
    expect(fail(w, cmd('entity.update', { id: 'ghost', set: {} }))).toBe('entity.not_found');
    expect(
      fail(
        w,
        cmd('entity.setField', { id: 'hollows', field: 'danger', value: { min: 5, max: 1 } }),
      ),
    ).toBe('world.invalid');
  });

  it('deletes with a cascade over relations and ref fields', () => {
    const w = ok(base(), cmd('entity.delete', { id: 'hollows' }));
    expect(getEntity(w, 'hollows')).toBeUndefined();
    expect(getEntity(w, 'glowmoss-caverns')?.fields.band).toBeUndefined();
    expect(getEntity(w, 'spore-lantern')?.relations.some((r) => r.target === 'hollows')).toBe(
      false,
    );
    expect(errorsOnly(validateWorld(w))).toEqual([]);
    expect(validateWorld(w).filter((p) => p.code.includes('dangling'))).toEqual([]);
  });

  it('follows the lifecycle and its gates', () => {
    const w = base();
    expect(fail(w, cmd('entity.setState', { id: 'spore-lantern', state: 'decided' }))).toBe(
      'state.missing_fields',
    );
    expect(fail(w, cmd('entity.setState', { id: 'spore-lantern', state: 'exported' }))).toBe(
      'state.transition',
    );
    expect(fail(w, cmd('entity.setState', { id: 'spore-lantern', state: 'shaped' }))).toBe(
      'state.same',
    );
    expect(fail(w, cmd('entity.setState', { id: 'sky-coral', state: 'shaped' }))).toBe(
      'state.missing_fields',
    );
    expect(fail(w, cmd('entity.setState', { id: 'vent-glass', state: 'graveyard' }))).toBe(
      'state.kill_reason',
    );
    const decided = ok(
      w,
      cmd('entity.setState', { id: 'first-descent', state: 'decided', why: 'It earns slot four.' }),
    );
    expect(getEntity(decided, 'first-descent')?.state).toBe('decided');
    const dead = ok(
      w,
      cmd('entity.setState', {
        id: 'vent-glass',
        state: 'graveyard',
        killed: { reason: 'fiddly' },
      }),
    );
    expect(getEntity(dead, 'vent-glass')?.killed).toEqual({ reason: 'fiddly' });
    const back = ok(dead, cmd('entity.setState', { id: 'vent-glass', state: 'idea' }));
    expect(getEntity(back, 'vent-glass')?.killed).toBeUndefined();
  });

  it('sets and removes attributes within their definitions', () => {
    let w = ok(
      base(),
      cmd('entity.setAttribute', {
        id: 'vent-glass-visor',
        key: 'defense',
        value: 9,
        source: 'ai',
      }),
    );
    expect(getEntity(w, 'vent-glass-visor')?.attributes.defense).toBe(9);
    expect(getEntity(w, 'vent-glass-visor')?.ai_fields).toEqual(['attributes.defense']);
    w = ok(w, cmd('entity.setAttribute', { id: 'vent-glass-visor', key: 'defense', value: null }));
    expect(getEntity(w, 'vent-glass-visor')?.attributes).toEqual({});
    expect(
      fail(w, cmd('entity.setAttribute', { id: 'vent-glass-visor', key: 'defense', value: -1 })),
    ).toBe('world.invalid');
  });

  it('rejects unknown commands and bad payloads', () => {
    expect(applyCommand(base(), { type: 'nope', payload: {} }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'command.unknown' },
    });
    expect(
      applyCommand(base(), { type: 'entity.create', payload: { kind: 'hat' } }, ctx),
    ).toMatchObject({ ok: false, error: { code: 'command.payload' } });
  });
});

describe('world commands', () => {
  it('edits numbers, settings, taste, spreads and schema', () => {
    let w = ok(base(), cmd('numbers.setVariable', { name: 'tier', value: 3 }));
    w = ok(w, cmd('numbers.setVariable', { name: 'k', value: null }));
    expect(w.numbers.variables).toEqual({ base_health: 100, tier: 3 });
    w = ok(w, cmd('numbers.setFormulas', { source: 'x = 1' }));
    expect(w.numbers.formulas).toBe('x = 1');
    w = ok(w, cmd('settings.set', { key: 'layouts', value: [{ name: 'default' }] }));
    expect(w.settings.layouts).toEqual([{ name: 'default' }]);
    expect(fail(w, cmd('settings.set', { key: 'name', value: 3 }))).toBe('world.invalid');
    expect(fail(w, cmd('settings.set', { key: 'format', value: 3 }))).toBe('command.payload');
    w = ok(w, cmd('taste.set', { rules: [] }));
    expect(w.taste.rules).toEqual([]);
    w = ok(w, cmd('spread.put', { record: { id: 's-1', created: ctx.now, move: 'fill' } }));
    expect(w.spreads['s-1']?.move).toBe('fill');
    w = ok(w, cmd('spread.remove', { id: 's-1' }));
    expect(fail(w, cmd('spread.remove', { id: 's-1' }))).toBe('spread.not_found');
    w = ok(w, cmd('schema.setAttributeDef', { kind: 'item', def: { key: 'weight', min: 0 } }));
    expect(w.schema.kinds.item?.attributes?.map((a) => a.key)).toEqual(['weight']);
    // Narrowing an enum would invalidate Spore Lantern (a tool): refused.
    expect(
      fail(
        w,
        cmd('schema.setKind', {
          kind: 'item',
          override: {
            fields: [{ key: 'subkind', label: 'Subkind', type: 'enum', options: ['armor'] }],
          },
        }),
      ),
    ).toBe('world.invalid');
    expect(
      fail(
        w,
        cmd('schema.setKind', {
          kind: 'item',
          override: { fields: [{ key: 'name', label: 'N', type: 'text' }] },
        }),
      ),
    ).toBe('world.invalid');
    w = ok(w, cmd('schema.setKind', { kind: 'item', override: null }));
    w = ok(
      w,
      cmd('schema.setRelationType', {
        type: 'echoes',
        def: {
          type: 'echoes',
          label: 'echoes',
          inverseLabel: 'echoed by',
          from: '*',
          to: '*',
          symmetric: false,
          acyclic: false,
        },
      }),
    );
    w = ok(w, cmd('relation.add', { from: 'glide', type: 'echoes', to: 'hollows' }));
    expect(
      fail(
        w,
        cmd('schema.setRelationType', {
          type: 'echoes',
          def: {
            type: 'other',
            label: 'x',
            inverseLabel: 'y',
            from: '*',
            to: '*',
            symmetric: false,
            acyclic: false,
          },
        }),
      ),
    ).toBe('schema.mismatch');
    expect(fail(w, cmd('schema.setRelationType', { type: 'echoes', def: null }))).toBe(
      'world.invalid',
    );
  });
});

describe('transactions', () => {
  it('apply all or nothing, with one combined inverse', () => {
    const w = base();
    const cmds = [
      cmd('entity.create', { kind: 'material', name: 'Ash', id: 'ash' }),
      cmd('relation.add', { from: 'ash', type: 'found_in', to: 'ash-vents' }),
    ];
    const r = applyCommands(w, cmds, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(applyPatch(r.value.world, r.value.inverse)).toEqual(w);
    expect(labelOf(w, cmds)).toBe('Create Ash (+1)');
    const bad = applyCommands(w, [...cmds, cmd('entity.delete', { id: 'ghost' })], ctx);
    expect(bad).toMatchObject({
      ok: false,
      error: { code: 'entity.not_found', detail: { index: 2 } },
    });
    expect(labelOf(w, [])).toBe('Nothing');
  });
});

describe('properties', () => {
  const ids = Object.keys(sampleWorld().entities);

  it('every command either fails cleanly or leaves the world valid, and its inverse restores it exactly', () => {
    fc.assert(
      fc.property(fc.array(commandArb(ids), { minLength: 1, maxLength: 12 }), (cmds) => {
        let w = base();
        for (const c of cmds) {
          const r = applyCommand(w, c, ctx);
          if (!r.ok) continue;
          expect(errorsOnly(validateWorld(r.value.world))).toEqual([]);
          expect(applyPatch(r.value.world, r.value.inverse)).toEqual(w);
          w = deepFreeze(r.value.world);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a transaction of any commands is invertible as a unit', () => {
    fc.assert(
      fc.property(fc.array(commandArb(ids), { maxLength: 8 }), (cmds) => {
        const w = base();
        const r = applyCommands(w, cmds, ctx);
        if (r.ok) expect(applyPatch(r.value.world, r.value.inverse)).toEqual(w);
      }),
      { numRuns: 200 },
    );
  });
});
