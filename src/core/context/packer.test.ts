import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sampleWorld } from '../testing/sample';
import { deepFreeze } from '../util/json';
import { DEFAULT_BUDGET, HARD_LIMIT, packContext } from './packer';
import { defaultPlacement } from './placement';
import { rankEntities, referencesOf } from './relevance';
import { renderDigest, renderFull, renderSummary, renderTaste } from './render';
import { syntheticWorld } from './testing';
import { clipToTokens, estimateTokens } from './tokens';

const world = sampleWorld();

describe('token estimates', () => {
  it('is zero for empty text, monotonic and conservative', () => {
    expect(estimateTokens('')).toBe(0);
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(estimateTokens(a + b)).toBeGreaterThanOrEqual(estimateTokens(a));
        // At least one token per 3 characters (the tokenizer averages more than that).
        expect(estimateTokens(a)).toBeGreaterThanOrEqual(Math.ceil(a.length / 3));
      }),
    );
  });

  it('clips text to a token budget', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), fc.integer({ min: 0, max: 600 }), (s, n) => {
        const c = clipToTokens(s, n);
        expect(estimateTokens(c)).toBeLessThanOrEqual(Math.max(n, 0));
        if (estimateTokens(s) <= n) expect(c).toBe(s);
      }),
    );
    expect(clipToTokens('one two three four five six seven', 8)).toMatch(/ …$/);
  });
});

describe('placement adapter', () => {
  it('reads band and biome from the resolver, and marks lived-in places inferred', () => {
    expect(defaultPlacement(world, world.entities['hollows']!)).toEqual({
      band: 'hollows',
      inferred: false,
    });
    expect(defaultPlacement(world, world.entities['glowmoss-caverns']!)).toMatchObject({
      band: 'hollows',
      biome: 'glowmoss-caverns',
      inferred: false,
    });
    const lumen = defaultPlacement(world, world.entities['lumen-spore']!);
    expect(lumen).toMatchObject({ biome: 'glowmoss-caverns', band: 'hollows', inferred: true });
  });
});

describe('relevance ranking', () => {
  it('orders direct relations, then the cell, band, kind, then the rest', () => {
    const ranked = rankEntities(world, { entities: ['cinder-wasp'] });
    const tiers = ranked.map((r) => r.tier);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    expect(ranked.some((r) => r.entity.id === 'cinder-wasp')).toBe(false);
    const wasp = world.entities['cinder-wasp']!;
    for (const r of ranked.filter((x) => x.tier === 0))
      expect(referencesOf(wasp).has(r.entity.id) || referencesOf(r.entity).has('cinder-wasp')).toBe(
        true,
      );
  });

  it('is a deterministic total order (property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 120 }), fc.nat(), (seed, n, pick) => {
        const w = syntheticWorld(seed, n);
        const ids = Object.keys(w.entities);
        const focus = { entities: [ids[pick % ids.length]!] };
        const a = rankEntities(w, focus).map((r) => `${r.tier}:${r.entity.id}`);
        // Same input, same order — even from a world built with keys in another order.
        const shuffled = {
          ...w,
          entities: Object.fromEntries([...Object.entries(w.entities)].reverse()),
        };
        const b = rankEntities(shuffled, focus).map((r) => `${r.tier}:${r.entity.id}`);
        expect(b).toEqual(a);
        expect(a).toHaveLength(ids.length - 1);
        expect(new Set(a).size).toBe(a.length);
      }),
      { numRuns: 60 },
    );
  });

  it('ranks the cell of a spot above the rest of its band', () => {
    const ranked = rankEntities(world, { entities: [], band: 'hollows', lane: 'creatures' });
    const first = ranked[0]!;
    expect(first.tier).toBeLessThanOrEqual(1);
    const byTier = ranked.filter((r) => r.tier === 1).map((r) => r.entity.kind);
    expect(byTier.every((k) => k === 'creature')).toBe(true);
  });
});

describe('renderings', () => {
  it('summarise in one line and render every filled field in full', () => {
    const e = world.entities['spore-lantern']!;
    expect(renderSummary(e)).not.toContain('\n');
    const full = renderFull(world, e);
    expect(full).toContain(e.name);
    expect(full).toContain('relations:');
    expect(renderDigest(world)).toContain('Hollows');
    expect(renderDigest(world, 3).length).toBeLessThan(renderDigest(world, 0).length);
    expect(renderTaste(world)).toContain('Rules');
    expect(renderTaste(world, { withoutRules: true })).toContain('(none)');
  });

  it('never mutates the world', () => {
    const frozen = deepFreeze(sampleWorld());
    expect(() => packContext(frozen, { entities: ['glide'] })).not.toThrow();
  });
});

describe('packContext', () => {
  it('packs the sample world in full with room to spare', () => {
    const p = packContext(world, { entities: ['spore-lantern'] });
    expect(p.tokens.total).toBeLessThanOrEqual(DEFAULT_BUDGET);
    expect(p.omitted).toBe(0);
    expect(p.focus).toContain('spore-lantern');
    expect(p.included.length).toBe(Object.keys(world.entities).length - 1);
    expect(p.included.some((x) => x.rendering === 'full')).toBe(true);
  });

  it('never exceeds its budget, for any world, focus and budget (property)', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 0, max: 120_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.double({ min: 0.2, max: 20, noNaN: true }),
        fc.nat(),
        (seed, n, budget, reserved, scale, pick) => {
          const w = syntheticWorld(seed, n, scale);
          const ids = Object.keys(w.entities);
          const p = packContext(w, { entities: [ids[pick % ids.length]!] }, { budget, reserved });
          const limit = Math.max(0, Math.min(budget, HARD_LIMIT) - reserved);
          expect(p.tokens.budget).toBe(limit);
          expect(p.tokens.total).toBeLessThanOrEqual(limit);
          // The reported total is the real estimate of the texts.
          expect(
            estimateTokens(p.digest) +
              estimateTokens(p.taste) +
              estimateTokens(p.focus) +
              estimateTokens(p.neighbours),
          ).toBe(p.tokens.total);
          expect(p.included.length + p.omitted).toBe(ids.length - 1);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('is deterministic: the same input gives byte-identical output (property)', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 500, max: 40_000 }),
        (seed, n, budget) => {
          const a = packContext(
            syntheticWorld(seed, n),
            { entities: [], band: 'band-0', lane: 'items' },
            { budget },
          );
          const b = packContext(
            syntheticWorld(seed, n),
            { entities: [], band: 'band-0', lane: 'items' },
            { budget },
          );
          expect(b).toEqual(a);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('keeps entities in relevance order and fills the most relevant first', () => {
    const w = syntheticWorld('big', 3000, 3);
    const focus = { entities: ['item-500'] };
    const p = packContext(w, focus, { budget: 20_000 });
    expect(p.omitted).toBeGreaterThan(0);
    const order = rankEntities(w, focus).map((r) => r.entity.id);
    const positions = p.included.map((x) => order.indexOf(x.id));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(p.tokens.total).toBeLessThanOrEqual(20_000);
  });

  it('shrinks the digest for huge worlds and clamps to the hard limit', () => {
    const w = syntheticWorld('huge', 6000, 2);
    const p = packContext(w, { entities: [] }, { budget: 500_000 });
    expect(p.tokens.budget).toBe(HARD_LIMIT);
    expect(p.tokens.total).toBeLessThanOrEqual(HARD_LIMIT);
    const tiny = packContext(w, { entities: [] }, { budget: 3_000 });
    expect(tiny.digestLevel).toBeGreaterThan(0);
    expect(tiny.tokens.total).toBeLessThanOrEqual(3_000);
  });

  it('packs nothing into a zero budget', () => {
    const p = packContext(world, { entities: ['glide'] }, { budget: 0 });
    expect(p.tokens.total).toBe(0);
    expect(p.included).toEqual([]);
  });

  it('renders taste switches and the wildcard without rules', () => {
    const p = packContext(world, { entities: [] }, { taste: { withoutRules: true } });
    expect(p.taste).not.toContain(world.taste.rules[0]!.text);
  });
});
