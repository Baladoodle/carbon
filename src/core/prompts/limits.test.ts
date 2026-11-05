import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MOMENTS, MOMENT_SCHEMAS, type Moment } from '../ai/moments';
import { HARD_LIMIT } from '../context/packer';
import { syntheticWorld } from '../context/testing';
import { estimateTokens } from '../context/tokens';
import type { World } from '../model/world';
import { createPromptRegistry } from './registry';
import type { BuiltPrompt } from './types';

/**
 * "No request goes over 100k tokens" (SYSTEM §8), as a property over huge
 * worlds (review-b). The bound used here is deliberately pessimistic for
 * anything that isn't ASCII: a byte-level tokenizer never makes more tokens
 * than UTF-8 bytes, so every non-ASCII character counts as its UTF-8 length.
 * ASCII counts at the packer's documented 2.8 characters per token; the
 * gateway's `count_tokens` check near the limit backs that figure up.
 */
function upperBound(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) ascii++;
    else other += cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return Math.ceil(ascii / 2.8) + other;
}

/** Everything a request sends that counts as input: the prompt blocks and the output schema. */
const requestBound = (p: BuiltPrompt): number =>
  [...p.system, ...p.user].reduce((n, b) => n + upperBound(b.text) + 4, 0) +
  upperBound(JSON.stringify(p.schema));

const EMOJI = '🜂🌋🫧🪨';
const CJK = '灰烬玻璃漂流苔藓';

/** A huge world, with the focused entities carrying enormous, mostly non-ASCII text. */
function hugeWorld(seed: string, count: number, scale: number, junk: string): World {
  const w = syntheticWorld(seed, count, scale);
  const big = junk.repeat(Math.ceil(300_000 / junk.length));
  const ids = Object.keys(w.entities);
  for (const id of ids.slice(0, 40)) {
    const e = w.entities[id];
    if (!e) continue;
    e.description = big;
    e.identity = big.slice(0, 20_000);
    e.name = `${big.slice(0, 2_000)} ${id}`;
    e.why = big.slice(0, 50_000);
    e.tags = Array.from({ length: 200 }, (_, i) => `${junk}${i}`);
  }
  w.taste.rules = Array.from({ length: 2_000 }, (_, i) => ({
    id: `rule-${i}`,
    text: big.slice(0, 2_000),
    enabled: true,
  }));
  w.taste.patterns = Array.from({ length: 500 }, (_, i) => ({
    id: `p-${i}`,
    text: big.slice(0, 2_000),
    status: 'promoted' as const,
    strength: 0.9,
    examples: [big.slice(0, 500)],
  }));
  w.numbers.formulas = Array.from(
    { length: 300 },
    (_, i) => `f${i} = ${i} + sum(items, .power) # ${big.slice(0, 200)}`,
  ).join('\n');
  return w;
}

function requestFor(m: Moment, w: World, junk: string): unknown {
  const ids = Object.keys(w.entities);
  const item = ids.find((id) => w.entities[id]?.kind === 'item') ?? (ids[0] as string);
  const first = ids[0] as string;
  const avoid = Array.from({ length: 300 }, () => junk.repeat(200));
  switch (m) {
    case 'suggest_one':
    case 'suggest_three':
      return { entityId: first, field: 'description', avoid };
    case 'fill_entity':
      return { entityId: item };
    case 'critique':
      return { entityId: first, trigger: 'on_demand' };
    case 'spec_draft':
      return { entityIds: ids.slice(0, 400), name: junk.repeat(2_000) };
    case 'spread':
      return {
        spot: { type: 'selection', entities: ids.slice(0, 40) },
        move: 'alloy',
        direction: junk.repeat(10).slice(0, 300),
      };
    case 'patterns':
      return {
        judgements: Array.from({ length: 200 }, () => ({
          candidate: { name: junk.repeat(100), identity: junk.repeat(500), kind: 'item' },
          verdict: 'kill',
          reason: 'seen it',
          note: junk.repeat(500),
        })),
      };
  }
}

describe('every request stays under 100k tokens', () => {
  const registry = createPromptRegistry();

  it('for every moment, over huge worlds full of non-ASCII text', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.integer({ min: 50, max: 2_500 }),
        fc.integer({ min: 1, max: 40 }),
        fc.constantFrom(EMOJI, CJK, 'plain ascii words ', 'é'),
        fc.constantFrom(60_000, 95_000),
        (seed, count, scale, junk, packBudget) => {
          const w = hugeWorld(seed, count, scale, junk);
          for (const m of MOMENTS) {
            const builder = registry.get(m);
            if (!builder) throw new Error(`no builder for ${m}`);
            const req = MOMENT_SCHEMAS[m].request.safeParse(requestFor(m, w, junk));
            if (!req.success) throw new Error(`${m}: ${req.error.message}`);
            const built = builder.build(w, req.data as never, { pack: { budget: packBudget } });
            if (!built.ok) continue; // e.g. nothing to fill
            const bound = requestBound(built.value);
            expect(bound, `${m} (${junk}, budget ${packBudget})`).toBeLessThanOrEqual(HARD_LIMIT);
            // The prompt's own estimate is as pessimistic as the bound, schema included.
            expect(built.value.estimate, m).toBeGreaterThanOrEqual(bound);
          }
        },
      ),
      { numRuns: 6 },
    );
  }, 120_000);

  it('a spec draft over hundreds of entities and formulas builds quickly', () => {
    const w = hugeWorld('spec', 2_000, 2, 'plain ascii words ');
    const ids = Object.keys(w.entities).slice(0, 400);
    const builder = registry.get('spec_draft');
    const req = MOMENT_SCHEMAS.spec_draft.request.parse({ entityIds: ids, name: 'Big set' });
    const t = performance.now();
    const built = builder?.build(w, req);
    expect(built?.ok).toBe(true);
    expect(performance.now() - t).toBeLessThan(1_500);
  });

  it('the local estimate never undercounts non-ASCII text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (s) => {
        expect(estimateTokens(s)).toBeGreaterThanOrEqual(upperBound(s));
      }),
    );
  });
});
