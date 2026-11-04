import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commandArb } from '../testing/arbitraries';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { applyCommands } from './apply';
import { diffWorlds } from './diff';
import { applyPatch } from './patch';

describe('diffWorlds', () => {
  it('is empty for equal worlds and minimal for one changed entity', () => {
    const w = sampleWorld();
    expect(diffWorlds(w, sampleWorld())).toEqual([]);
    const changed = {
      ...w,
      entities: { ...w.entities, glide: { ...w.entities.glide!, name: 'Soar' } },
    };
    expect(diffWorlds(w, changed)).toEqual([
      { op: 'set', path: ['entities', 'glide'], value: changed.entities.glide },
    ]);
    expect(diffWorlds({ a: 1, b: 2 }, { a: 1 })).toEqual([{ op: 'remove', path: ['b'] }]);
  });

  it('property: applying the diff gives the target world', () => {
    const ids = Object.keys(sampleWorld().entities);
    fc.assert(
      fc.property(fc.array(commandArb(ids), { maxLength: 8 }), (cmds) => {
        const w = sampleWorld();
        const r = applyCommands(w, cmds, { now: SAMPLE_TIME });
        if (!r.ok) return;
        expect(applyPatch(w, diffWorlds(w, r.value.world))).toEqual(r.value.world);
        expect(applyPatch(r.value.world, diffWorlds(r.value.world, w))).toEqual(w);
      }),
      { numRuns: 100 },
    );
  });
});
