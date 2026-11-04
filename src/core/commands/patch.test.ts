import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../util/json';
import {
  applyPatch,
  applyWithInverse,
  getAt,
  hasAt,
  PatchError,
  touchedKeys,
  type Patch,
} from './patch';

const key = fc.constantFrom('a', 'b', 'c', 'd');
const leaf = fc.oneof(
  fc.integer(),
  fc.string({ maxLength: 3 }),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 2 }),
);
const doc = fc.letrec((tie) => ({
  node: fc.dictionary(key, fc.oneof({ depthSize: 'small' }, leaf, tie('node')), { maxKeys: 4 }),
})).node;
const path = fc.array(key, { minLength: 1, maxLength: 3 });
const op = fc.oneof(
  fc.record({ op: fc.constant('set' as const), path, value: fc.oneof(leaf, fc.constant({})) }),
  fc.record({ op: fc.constant('remove' as const), path }),
);

describe('patch', () => {
  it('sets, removes and shares untouched branches', () => {
    const d = deepFreeze({ a: { x: 1 }, b: { y: 2 } });
    const n = applyPatch(d, [
      { op: 'set', path: ['a', 'x'], value: 5 },
      { op: 'remove', path: ['a', 'z'] },
    ]);
    expect(n).toEqual({ a: { x: 5 }, b: { y: 2 } });
    expect(n.b).toBe(d.b);
    expect(applyPatch(d, [{ op: 'remove', path: ['b'] }])).toEqual({ a: { x: 1 } });
  });

  it('throws PatchError for a missing intermediate or a non-object', () => {
    expect(() => applyPatch({ a: 1 }, [{ op: 'set', path: ['b', 'c'], value: 1 }])).toThrow(
      PatchError,
    );
    expect(() => applyPatch({ a: 1 }, [{ op: 'set', path: ['a', 'c'], value: 1 }])).toThrow(
      PatchError,
    );
  });

  it('reads paths', () => {
    expect(getAt({ a: { b: 2 } }, ['a', 'b'])).toBe(2);
    expect(getAt({ a: 1 }, ['a', 'b'])).toBeUndefined();
    expect(hasAt({ a: { b: undefined } }, ['a', 'b'])).toBe(true);
    expect(hasAt({ a: {} }, ['a', 'b'])).toBe(false);
    expect(
      touchedKeys([
        { op: 'set', path: ['entities', 'x', 'name'], value: 1 },
        { op: 'remove', path: ['numbers'] },
      ]),
    ).toEqual(['entities/x', 'numbers']);
  });

  it('property: applying a patch then its inverse restores the document exactly', () => {
    fc.assert(
      fc.property(doc, fc.array(op, { maxLength: 6 }), (d, ops) => {
        deepFreeze(d);
        let r: { doc: Record<string, unknown>; inverse: Patch };
        try {
          r = applyWithInverse(d, ops);
        } catch (e) {
          expect(e).toBeInstanceOf(PatchError);
          return;
        }
        expect(applyPatch(r.doc, r.inverse)).toEqual(d);
      }),
      { numRuns: 400 },
    );
  });

  it('property: a patch copies each container once, mutating neither the document nor the op values', () => {
    fc.assert(
      fc.property(doc, fc.array(op, { maxLength: 6 }), (d, ops) => {
        deepFreeze(d);
        deepFreeze(ops);
        let whole: Record<string, unknown>;
        try {
          whole = applyPatch(d, ops);
        } catch (e) {
          expect(e).toBeInstanceOf(PatchError);
          return;
        }
        // The same as applying the ops one patch at a time.
        let stepwise: Record<string, unknown> = d;
        for (const o of ops) stepwise = applyPatch(stepwise, [o]);
        expect(whole).toEqual(stepwise);
        // And the inverse path gives the same document.
        expect(applyWithInverse(d, ops).doc).toEqual(whole);
      }),
      { numRuns: 400 },
    );
  });
});
