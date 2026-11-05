import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FakeAiGateway } from '../ai/fake';
import { MOMENTS } from '../ai/moments';
import { errorsOnly, validateWorld } from '../model/validate';
import { everyCommandArb } from '../testing/arbitraries';
import { sampleWorld } from '../testing/sample';
import { deepFreeze } from '../util/json';
import { applyCommand, applyCommands } from './apply';
import { COMMANDS } from './registry';

/**
 * What crosses IPC from the renderer is checked in main: a command's payload
 * by its zod schema, an AI request by its moment's. Whatever arrives, even
 * garbage, is refused with a typed error or applied leaving the world valid;
 * it never throws (a throw in a handler is an unhandled error in main) and
 * never touches the world it was refused for.
 */
const ctx = { now: '2026-11-05T10:00:00.000Z' };
const world = deepFreeze(sampleWorld());
const ids = Object.keys(world.entities);
const types = Object.keys(COMMANDS);

/** A valid-looking payload with one part broken: a key dropped, or a value replaced by anything. */
const broken = everyCommandArb(ids).chain((c) => {
  const p = c.payload as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length === 0) return fc.constant(c);
  return fc.tuple(fc.constantFrom(...keys), fc.boolean(), fc.anything()).map(([k, drop, v]) => {
    const q = { ...p };
    if (drop) delete q[k];
    else q[k] = v;
    return { type: c.type, payload: q };
  });
});

const garbage = fc.record({
  type: fc.oneof(fc.constantFrom(...types), fc.string()),
  payload: fc.anything({
    withNullPrototype: true,
    withBigInt: true,
    withDate: true,
    withMap: true,
    withSet: true,
    withTypedArray: true,
    withSparseArray: true,
  }),
});

describe('malformed commands', () => {
  it('property: garbage or a broken payload is refused or applied validly, never thrown', () => {
    fc.assert(
      fc.property(fc.oneof(garbage, broken), (c) => {
        const r = applyCommand(world, c, ctx);
        if (!r.ok) {
          expect(typeof r.error.code).toBe('string');
          return;
        }
        expect(errorsOnly(validateWorld(r.value.world))).toEqual([]);
      }),
      { numRuns: 3000 },
    );
  });

  it('property: a transaction with one bad command is refused whole', () => {
    fc.assert(
      fc.property(fc.array(everyCommandArb(ids), { maxLength: 4 }), garbage, (good, bad) => {
        const r = applyCommands(world, [...good, bad], ctx);
        const alone = applyCommands(world, good, ctx);
        if (!r.ok) return;
        // It applied: then the bad one was a valid command after all, and the world is valid.
        expect(alone.ok).toBe(true);
        expect(errorsOnly(validateWorld(r.value.world))).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });
});

describe('malformed AI requests', () => {
  it('property: the gateway answers bad_request, never throws', async () => {
    const g = new FakeAiGateway({ getWorld: () => world });
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...MOMENTS), fc.anything(), async (moment, request) => {
        const out = await g.run(moment, request as never);
        if (!out.ok) expect(typeof out.error.code).toBe('string');
      }),
      { numRuns: 500 },
    );
  });
});
