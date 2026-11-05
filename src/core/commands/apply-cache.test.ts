import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Entity } from '../model/entity';
import type { World } from '../model/world';
import { commandArb } from '../testing/arbitraries';
import { sampleWorld } from '../testing/sample';
import { deepFreeze } from '../util/json';
import { applyCommand, applyCommands } from './apply';
import { cmd } from './registry';

/**
 * checkPatched keeps, per world, the ids that something points at but that
 * don't exist, so creating an entity re-checks the entities pointing at it
 * without scanning the whole world. These tests show the cache never changes
 * a command's outcome.
 */
const ctx = { now: '2026-11-05T10:00:00.000Z' };

/** The sample world after an outside edit: references to ids that don't exist yet. */
function dangling(): World {
  const w = structuredClone(sampleWorld());
  const lantern = w.entities['spore-lantern'] as Entity;
  w.entities['spore-lantern'] = {
    ...lantern,
    relations: [...lantern.relations, { type: 'requires', target: 'glass-lung' }],
  };
  const biome = Object.values(w.entities).find((e) => e.kind === 'biome') as Entity;
  w.entities[biome.id] = { ...biome, fields: { ...biome.fields, band: 'new-thing' } };
  return deepFreeze(w);
}

/** The same world with no cache behind it (a fresh entities object). */
const fresh = (w: World): World => structuredClone(w);

describe('the dangling-target cache in checkPatched', () => {
  it('refuses a create that resolves a dangling reference to the wrong kind', () => {
    const w = dangling();
    // glass-lung as a material: `requires` must point at a capability or an item.
    const bad = applyCommand(
      w,
      cmd('entity.create', { kind: 'material', name: 'Glass Lung', id: 'glass-lung' }),
      ctx,
    );
    expect(bad.ok).toBe(false);
    // new-thing as an item: a biome's band must be a band.
    const alsoBad = applyCommand(
      w,
      cmd('entity.create', { kind: 'item', name: 'New Thing', id: 'new-thing' }),
      ctx,
    );
    expect(alsoBad.ok).toBe(false);
    // The right kinds resolve them.
    expect(
      applyCommand(w, cmd('entity.create', { kind: 'band', name: 'N', id: 'new-thing' }), ctx).ok,
    ).toBe(true);
  });

  it('still catches it at the end of a long transaction (the cache carried through)', () => {
    const w = dangling();
    const many = Array.from({ length: 50 }, (_, i) =>
      cmd('entity.create', { kind: 'material', name: `Ore ${i}` }),
    );
    const r = applyCommands(
      w,
      [...many, cmd('entity.create', { kind: 'material', name: 'Glass Lung', id: 'glass-lung' })],
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.error.detail as { index: number }).index).toBe(50);
  });

  it('property: every command sequence has the same outcome with and without the cache', () => {
    const w0 = dangling();
    const ids = Object.keys(w0.entities);
    fc.assert(
      fc.property(fc.array(commandArb(ids), { maxLength: 12 }), (commands) => {
        let cached = w0;
        for (const c of commands) {
          const a = applyCommand(cached, c, ctx);
          const b = applyCommand(fresh(cached), c, ctx);
          expect(a.ok).toBe(b.ok);
          if (a.ok && b.ok) {
            expect(a.value.world).toEqual(b.value.world);
            cached = a.value.world;
          } else if (!a.ok && !b.ok) expect(a.error.code).toBe(b.error.code);
        }
      }),
      { numRuns: 400 },
    );
  });
});
