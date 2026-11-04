import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MOMENTS, MOMENT_SCHEMAS } from '../ai/moments';
import { applyCommand } from '../commands/apply';
import { cmd } from '../commands/registry';
import { sampleWorld } from '../testing/sample';
import { promptText, ROLE } from './common';
import { critiqueBuilder } from './critique';
import {
  fallbackPatternsBuilder,
  fallbackSpreadBuilder,
  spotFocus,
  spotKind,
} from './fallback-spread';
import { emptyFields, fillBuilder } from './fill';
import { BUILTIN_BUILDERS, createPromptRegistry, PromptRegistry } from './registry';
import { duplicatesName, fieldJsonSchema, validFieldValue, writableField } from './schema';
import { specBuilder } from './spec';
import { JsonArrayStreamer } from './stream';
import { suggestOneBuilder, suggestThreeBuilder } from './suggest';
import type { JsonSchema } from './types';

const world = sampleWorld();
const ctx = { now: '2026-11-04T10:00:00.000Z' };

/** Every object in a schema must be strict (structured outputs' subset). */
function assertStrict(s: unknown, at = '$'): void {
  if (!s || typeof s !== 'object') return;
  const o = s as JsonSchema;
  if (o.type === 'object') {
    expect(o.additionalProperties, at).toBe(false);
    expect([...(o.required as string[])].sort(), at).toEqual(
      Object.keys(o.properties as object).sort(),
    );
  }
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'])
    expect(o, `${at} has no ${k}`).not.toHaveProperty(k);
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) v.forEach((x, i) => assertStrict(x, `${at}.${k}[${i}]`));
    else if (v && typeof v === 'object') assertStrict(v, `${at}.${k}`);
  }
}

const build = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('registry', () => {
  it('has a builder for every moment, and package builders replace built-ins', () => {
    const r = createPromptRegistry();
    expect(r.missing()).toEqual([]);
    for (const m of MOMENTS) expect(r.get(m)?.moment).toBe(m);
    const mine = {
      ...critiqueBuilder,
      defaults: { ...critiqueBuilder.defaults, effort: 'high' as const },
    };
    expect(createPromptRegistry([mine]).get('critique')?.defaults.effort).toBe('high');
    expect(new PromptRegistry().missing()).toEqual([...MOMENTS]);
    expect(new PromptRegistry().has('spread')).toBe(false);
    expect(BUILTIN_BUILDERS).toHaveLength(MOMENTS.length);
  });
});

describe('every built prompt', () => {
  const requests = {
    suggest_one: { entityId: 'spore-lantern', field: 'tradeoff' },
    suggest_three: { entityId: 'glide', field: 'name' },
    fill_entity: { entityId: 'high-drift' },
    critique: { entityId: 'cinder-wasp', trigger: 'finish_edit' },
    spec_draft: { entityIds: ['cinder-sting', 'glide'], name: 'First set' },
    spread: {
      spot: { type: 'cell', band: 'hollows', lane: 'creatures' },
      move: 'vary',
      direction: 'stranger',
    },
    patterns: {
      judgements: [
        {
          candidate: { name: 'A', identity: 'a', kind: 'item' },
          verdict: 'kill',
          reason: 'seen it',
        },
      ],
    },
  } as const;

  for (const m of MOMENTS) {
    it(`${m}: strict schema, cache layout, deterministic`, () => {
      const b = createPromptRegistry().get(m)!;
      const req = MOMENT_SCHEMAS[m].request.parse(requests[m]);
      const p = build(b.build(world, req as never));
      assertStrict(p.schema);
      expect(p.system[0]!.text).toBe(ROLE);
      expect(p.system.map((s) => s.label)).toEqual(['role', 'digest', 'taste', 'instructions']);
      expect(p.system.filter((s) => s.cache).length).toBeLessThanOrEqual(4);
      expect(p.user.at(-1)!.label).toBe('ask');
      expect(p.estimate).toBeGreaterThan(0);
      expect(p.estimate).toBeLessThan(95_000);
      expect(build(b.build(world, req as never))).toEqual(p);
      expect(promptText(p)).toContain('<<user: ask>>');
      expect(b.build(world, req as never, { effort: 'max', maxTokens: 999 })).toMatchObject({
        ok: true,
        value: { effort: 'max', maxTokens: 999 },
      });
    });
  }
});

describe('suggest', () => {
  it('builds for common and kind fields, refuses unknown ones', () => {
    expect(
      suggestOneBuilder.build(world, { entityId: 'ghost', field: 'name', avoid: [] }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(
      suggestOneBuilder.build(world, { entityId: 'glide', field: 'nope', avoid: [] }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    const p = build(
      suggestOneBuilder.build(world, {
        entityId: 'spore-lantern',
        field: 'subkind',
        avoid: ['tool'],
      }),
    );
    expect(p.user.at(-1)!.text).toContain('Options: armor');
    expect(p.user.at(-1)!.text).toContain('Already shown: tool');
    expect(p.schema).toMatchObject({
      properties: {
        suggestion: {
          properties: { value: { enum: ['armor', 'accessory', 'tool', 'weapon', 'consumable'] } },
        },
      },
    });
  });

  it('drops invalid values, repeats of shown values and duplicate names', () => {
    const req = { entityId: 'spore-lantern', field: 'tradeoff', avoid: ['heavy in water'] };
    expect(
      suggestOneBuilder.parse({ suggestion: { value: 'Heavy in water', note: 'x' } }, world, req),
    ).toMatchObject({ ok: false });
    expect(
      suggestOneBuilder.parse({ suggestion: { value: 'dims when you sprint' } }, world, req),
    ).toMatchObject({ ok: false });
    expect(
      suggestOneBuilder.parse(
        { suggestion: { value: '  Hums near ash  ', note: ' fits ' } },
        world,
        req,
      ),
    ).toEqual({
      ok: true,
      value: { result: { suggestion: { value: 'Hums near ash', note: 'fits' } }, dropped: 0 },
    });
    const names = { entityId: 'glide', field: 'name', avoid: [] };
    const three = suggestThreeBuilder.parse(
      {
        suggestions: [
          { value: 'Spore Lantern', note: '' },
          { value: 'Updraft' },
          { value: 'Kite' },
          { value: 'kite' },
          { value: 'Feather Fall' },
        ],
      },
      world,
      names,
    );
    expect(three).toEqual({
      ok: true,
      value: {
        result: {
          suggestions: [{ value: 'Updraft' }, { value: 'Kite' }, { value: 'Feather Fall' }],
        },
        dropped: 2,
      },
    });
    expect(
      suggestThreeBuilder.parse({ suggestions: [{ value: 'A' }] }, world, names),
    ).toMatchObject({ ok: false });
    expect(suggestThreeBuilder.parse(null, world, names)).toMatchObject({ ok: false });
  });
});

describe('fill', () => {
  it('asks only for empty, AI-writable fields and returns proposals the commands accept', () => {
    const e = world.entities['high-drift']!;
    const keys = emptyFields(world, e).map((f) => f.key);
    expect(keys).not.toContain('y_bottom');
    expect(keys).toContain('character');
    const out = build(
      fillBuilder.parse(
        {
          proposals: {
            character: { value: 'Silent and cold', note: 'fits debris' },
            danger: { value: { min: 5, max: 3 }, note: null }, // invalid range: dropped
            air: null,
            y_top: { value: 'up', note: null }, // not an empty field: dropped
          },
        },
        world,
        { entityId: 'high-drift' },
      ),
    );
    expect(out.dropped).toBe(2);
    expect(out.result.proposals).toEqual([
      { field: 'character', value: 'Silent and cold', note: 'fits debris' },
    ]);
    const set = Object.fromEntries(out.result.proposals.map((p) => [p.field, p.value]));
    expect(
      applyCommand(world, cmd('entity.update', { id: 'high-drift', set, source: 'ai' }), ctx).ok,
    ).toBe(true);
    expect(fillBuilder.parse({}, world, { entityId: 'high-drift' })).toMatchObject({ ok: false });
    expect(fillBuilder.build(world, { entityId: 'ghost' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('critique', () => {
  it('keeps only notes about real entities and rules, one per kind', () => {
    const rule = world.taste.rules[0]!;
    const out = build(
      critiqueBuilder.parse(
        {
          notes: [
            {
              kind: 'rule_clash',
              text: 'Breaks it.',
              entities: [],
              field: null,
              ruleId: `[${rule.id}]`,
            },
            { kind: 'rule_clash', text: 'Again.', entities: [], field: null, ruleId: rule.id },
            {
              kind: 'duplicate',
              text: 'Same as itself.',
              entities: ['cinder-wasp'],
              field: null,
              ruleId: null,
            },
            {
              kind: 'duplicate',
              text: 'Same as Glide.',
              entities: ['glide', 'cinder-wasp'],
              field: 'name',
              ruleId: null,
            },
            { kind: 'rule_clash', text: 'No rule.', entities: [], field: null, ruleId: null },
            { kind: 'weak_identity', text: '', entities: [], field: null, ruleId: null },
          ],
        },
        world,
        { entityId: 'cinder-wasp', trigger: 'on_demand' },
      ),
    );
    expect(out.result.notes).toEqual([
      { kind: 'rule_clash', text: 'Breaks it.', entities: [], ruleId: rule.id },
      { kind: 'duplicate', text: 'Same as Glide.', entities: ['glide'], field: 'name' },
    ]);
    expect(out.dropped).toBe(4);
  });

  it('tells the model which relation targets are missing', () => {
    const w = structuredClone(world);
    w.entities['glide']!.relations.push({ type: 'requires', target: 'nowhere-item' });
    const p = build(critiqueBuilder.build(w, { entityId: 'glide', trigger: 'state_change' }));
    expect(p.user.at(-1)!.text).toContain('requires → nowhere-item');
  });
});

describe('spec draft', () => {
  it('includes the numbers and refuses missing entities', () => {
    const p = build(
      specBuilder.build(world, { entityIds: ['cinder-sting'], name: 'First weapon' }),
    );
    expect(p.entity).toBe('cinder-sting');
    if (world.numbers.formulas) expect(p.user.at(-1)!.text).toContain('Numbers in the world');
    expect(specBuilder.build(world, { entityIds: ['ghost'], name: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(
      specBuilder.parse({ title: 'T', markdown: '# T' }, world, {
        entityIds: ['glide'],
        name: 'T',
      }),
    ).toEqual({
      ok: true,
      value: { result: { title: 'T', markdown: '# T\n' }, dropped: 0 },
    });
    expect(
      specBuilder.parse({ title: '', markdown: '' }, world, { entityIds: ['glide'], name: 'T' }),
    ).toMatchObject({ ok: false });
  });
});

describe('fallback spread and patterns', () => {
  const req = MOMENT_SCHEMAS.spread.request.parse({
    spot: { type: 'cell', band: 'low-sky', lane: 'items' },
    move: 'fill',
    count: 3,
  });

  it('derives kind and focus from every spot type', () => {
    expect(spotKind(world, req.spot, 'fill')).toBe('item');
    expect(spotKind(world, req.spot, 'break')).toBeNull();
    expect(
      spotKind(
        world,
        {
          type: 'region',
          band: 'hollows',
          climate: { temperature: { min: 0, max: 1 }, moisture: { min: 0, max: 1 } },
        },
        'fill',
      ),
    ).toBe('biome');
    expect(spotKind(world, { type: 'entity', entity: 'glide' }, 'vary')).toBe('capability');
    expect(spotKind(world, { type: 'selection', entities: ['cinder-wasp'] }, 'vary')).toBe(
      'creature',
    );
    expect(spotKind(world, { type: 'note', note: 'n', entities: [] }, 'vary')).toBeNull();
    expect(
      spotFocus({
        type: 'region',
        band: 'hollows',
        climate: { temperature: { min: 0, max: 1 }, moisture: { min: 0, max: 1 } },
      }),
    ).toEqual({ entities: [], band: 'hollows', kind: 'biome' });
    expect(
      fallbackSpreadBuilder.build(world, { ...req, spot: { type: 'entity', entity: 'ghost' } }),
    ).toMatchObject({ ok: false });
  });

  it('validates candidates, keeps exactly one wildcard, honours given axes', () => {
    const c = (name: string, more: Record<string, unknown> = {}) => ({
      kind: 'item',
      name,
      identity: 'x',
      description: ' d ',
      attributes: [
        { key: 'weight', value: 2 },
        { key: 'Bad Key', value: 1 },
      ],
      relations: [
        { type: 'in_band', target: 'low-sky', note: 'up here' },
        { type: 'lives_in', target: 'low-sky', note: '' },
      ],
      about: 'ghost',
      position: { x: 2, y: -1 },
      wildcard: true,
      rationale: '',
      ...more,
    });
    const axes = { x: { label: 'a', low: 'l', high: 'h' }, y: { label: 'b', low: 'l', high: 'h' } };
    const out = build(
      fallbackSpreadBuilder.parse(
        {
          axes,
          candidates: [
            c('Kite Lung'),
            c('kite lung'),
            c('Sky Anchor'),
            c('Wrong', { kind: 'creature' }),
            c(''),
            'junk',
          ],
        },
        world,
        req,
      ),
    );
    expect(out.result.candidates.map((x) => x.name)).toEqual(['Kite Lung', 'Sky Anchor']);
    expect(out.result.candidates.map((x) => x.wildcard)).toEqual([true, false]);
    expect(out.result.candidates[0]).toMatchObject({
      key: 'c1',
      attributes: { weight: 2 },
      relations: [{ type: 'in_band', target: 'low-sky', note: 'up here' }],
      position: { x: 1, y: 0 },
      description: 'd',
    });
    expect(out.result.candidates[0]).not.toHaveProperty('about');
    expect(out.dropped).toBe(4);
    const noWild = build(
      fallbackSpreadBuilder.parse(
        { axes, candidates: [c('A1', { wildcard: false }), c('B1', { wildcard: false })] },
        world,
        req,
      ),
    );
    expect(noWild.result.candidates.map((x) => x.wildcard)).toEqual([false, true]);
    const given = { ...req, axes };
    expect(
      build(fallbackSpreadBuilder.parse({ candidates: [] }, world, given)).result.axes,
    ).toEqual(axes);
    expect(fallbackSpreadBuilder.parse({ candidates: [] }, world, req)).toMatchObject({
      ok: false,
    });
    expect(fallbackSpreadBuilder.stream!.item('junk', 0, world, req)).toBeNull();
  });

  it('parses patterns and keeps updates only for existing patterns', () => {
    const out = build(
      fallbackPatternsBuilder.parse(
        {
          patterns: [
            { text: 'You kill stat sticks.', examples: ['A', 3], strength: 1.4, updates: 'nope' },
            { text: '', strength: 1 },
          ],
        },
        world,
        { judgements: [] },
      ),
    );
    expect(out.result.patterns).toEqual([
      { text: 'You kill stat sticks.', examples: ['A'], strength: 1 },
    ]);
    expect(out.dropped).toBe(1);
    expect(fallbackPatternsBuilder.parse({}, world, { judgements: [] })).toMatchObject({
      ok: false,
    });
  });
});

describe('field schemas and values', () => {
  it('validates every field type and resolves references', () => {
    const route = writableField(world, 'item', 'route')!;
    expect(
      validFieldValue(world, route, [
        { text: 'a', needs: [] },
        { text: 'b', needs: ['lumen-spore'] },
      ]),
    ).toEqual([{ text: 'a' }, { text: 'b', needs: ['lumen-spore'] }]);
    expect(validFieldValue(world, route, [{ text: 'b', needs: ['ghost'] }])).toBeUndefined();
    const band = writableField(world, 'biome', 'band')!;
    expect(validFieldValue(world, band, 'hollows')).toBe('hollows');
    expect(validFieldValue(world, band, 'glide')).toBeUndefined();
    expect((fieldJsonSchema(world, band.def!) as { enum: string[] }).enum).toContain('hollows');
    const tags = writableField(world, 'item', 'tags')!;
    expect(validFieldValue(world, tags, [' a ', ''])).toEqual(['a']);
    expect(validFieldValue(world, tags, 'a')).toBeUndefined();
    expect(validFieldValue(world, writableField(world, 'item', 'name')!, '  ')).toBeUndefined();
    expect(validFieldValue(world, writableField(world, 'item', 'change')!, '  ')).toBeUndefined();
    expect(writableField(world, 'item', 'nope')).toBeNull();
    expect(duplicatesName(world, 'SPORE-lantern')).toBe(true);
    expect(duplicatesName(world, 'Spore Lantern', 'spore-lantern')).toBe(false);
    expect(duplicatesName(world, '!!!')).toBe(false);
  });

  it('every kind field has a strict JSON schema', () => {
    const { kinds } = { kinds: Object.values(world.entities).map((e) => e.kind) };
    for (const kind of new Set(kinds))
      for (const key of Object.keys(
        world.entities[Object.values(world.entities).find((e) => e.kind === kind)!.id]!.fields,
      )) {
        const f = writableField(world, kind, key);
        if (f?.def) assertStrict(fieldJsonSchema(world, f.def));
      }
  });
});

describe('JsonArrayStreamer', () => {
  it('yields each item once, as soon as it is complete, however the text is split (property)', () => {
    const item = fc.record({
      name: fc.string(),
      n: fc.integer(),
      nested: fc.array(fc.record({ s: fc.string() }), { maxLength: 3 }),
    });
    fc.assert(
      fc.property(
        fc.array(item, { maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 50 }),
        fc.string(),
        (items, cuts, pre) => {
          const text = JSON.stringify({
            axes: { x: '[{]', y: pre },
            candidates: items,
            after: [{ no: 1 }],
          });
          const s = new JsonArrayStreamer('candidates');
          const got: unknown[] = [];
          let i = 0;
          let k = 0;
          while (i < text.length) {
            const n = cuts[k++ % cuts.length]!;
            got.push(...s.push(text.slice(i, i + n)));
            i += n;
          }
          expect(got).toEqual(items);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reports a malformed item as undefined and ignores other keys', () => {
    const s = new JsonArrayStreamer('candidates');
    expect(s.push('{"other":[{"a":1}],"candidates":[{"a":1},')).toEqual([{ a: 1 }]);
    expect(s.push('{"b":tru}]}')).toEqual([undefined]);
  });
});
