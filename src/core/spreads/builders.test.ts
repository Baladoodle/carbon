import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CandidateSchema,
  MOMENT_SCHEMAS,
  PatternsResultSchema,
  SpreadResultSchema,
  type Move,
  type Spot,
} from '../ai/moments';
import { applyCommand, applyCommands } from '../commands/apply';
import { cmd } from '../commands/registry';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import {
  createSpreadPromptBuilders,
  expectedKind,
  fieldJson,
  parsePatternsOutput,
  parseSpreadCandidate,
  parseSpreadOutput,
  spotFocusOf,
  spreadAsk,
  spreadOutputSchema,
  type AssembleLike,
} from './builders';
import { MOVE_DEFS } from './moves';
import { makeSpread } from './record';
import { keepCommands } from './triage';

const world = sampleWorld();
const req = (spot: Spot, move: Move, extra = {}) =>
  MOMENT_SCHEMAS.spread.request.parse({ spot, move, ...extra });
const CELL: Spot = { type: 'cell', band: 'low-sky', lane: 'items' };
const ANKLET: Spot = { type: 'entity', entity: 'cloud-anklet' };

const raw = (over: Record<string, unknown> = {}) => ({
  kind: 'item',
  name: 'Glass Lung',
  identity: 'Breathe the thin air.',
  description: '',
  fields: { subkind: 'accessory', slot: null, change: 'You can stay high longer.', bogus: 1 },
  attributes: [{ key: 'weight', value: 2 }],
  relations: [
    { type: 'made_from', target: 'sky-coral', note: 'light' },
    { type: 'made_from', target: 'ghost', note: '' },
  ],
  about: null,
  position: { x: 2, y: -1 },
  wildcard: false,
  rationale: 'fits the sky',
  ...over,
});

describe('spread output schema', () => {
  it('closes every object, uses the kind’s own fields, and fixes kind and about', () => {
    const s = spreadOutputSchema(world, req(CELL, 'fill')) as {
      required: string[];
      additionalProperties: boolean;
      properties: {
        candidates: { items: { properties: Record<string, Record<string, unknown>> } };
      };
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['axes', 'candidates']);
    const c = s.properties.candidates.items.properties;
    expect(c.kind).toEqual({ type: 'string', enum: ['item'] });
    expect(Object.keys((c.fields as { properties: object }).properties)).toEqual([
      'subkind',
      'slot',
      'change',
      'tradeoff',
      'moment',
      'route',
    ]);
    expect(c.about).toEqual({ type: 'null' });
    const g = spreadOutputSchema(world, req(ANKLET, 'ground')) as typeof s;
    expect(g.properties.candidates.items.properties.about).toEqual({
      type: 'string',
      enum: ['cloud-anklet'],
    });
    const b = spreadOutputSchema(world, req(ANKLET, 'break')) as typeof s;
    expect(b.properties.candidates.items.properties.kind).toEqual({ type: 'null' });
    const region = spreadOutputSchema(
      world,
      req(
        {
          type: 'region',
          band: 'hollows',
          climate: { temperature: { min: 0, max: 1 }, moisture: { min: 0, max: 1 } },
        },
        'fill',
      ),
    ) as typeof s;
    expect(
      Object.keys(
        (region.properties.candidates.items.properties.fields as { properties: object }).properties,
      ),
    ).not.toContain('band');
    expect(JSON.stringify(s)).not.toContain('undefined');
  });

  it('describes every field type', () => {
    const types = [
      'text',
      'longtext',
      'number',
      'range',
      'enum',
      'list',
      'height',
      'ref',
      'climate',
      'steps',
      'boolean',
    ] as const;
    for (const type of types) {
      const j = fieldJson(world, {
        key: 'k',
        label: 'K',
        type,
        ...(type === 'enum' ? { options: ['a'] } : {}),
        ...(type === 'ref' ? { refKinds: ['band'] } : {}),
      });
      expect(j, type).toBeTypeOf('object');
    }
    expect(fieldJson(world, { key: 'k', label: 'K', type: 'ref', refKinds: ['band'] })).toEqual({
      type: 'string',
      enum: ['groundline', 'high-drift', 'hollows', 'low-sky', 'undercroft'],
    });
    expect(fieldJson(world, { key: 'k', label: 'K', type: 'enum' })).toEqual({ type: 'string' });
    expect(expectedKind(world, req(CELL, 'break'))).toBeNull();
  });
});

describe('parsing candidates', () => {
  it('keeps what is valid and drops what is not', () => {
    const c = parseSpreadCandidate(world, req(CELL, 'fill'), raw(), 2);
    expect(c).toEqual({
      key: 'c3',
      kind: 'item',
      name: 'Glass Lung',
      identity: 'Breathe the thin air.',
      fields: { subkind: 'accessory', change: 'You can stay high longer.' },
      attributes: { weight: 2 },
      relations: [{ type: 'made_from', target: 'sky-coral', note: 'light' }],
      position: { x: 1, y: 0 },
      wildcard: false,
      rationale: 'fits the sky',
    });
    expect(CandidateSchema.safeParse(c).success).toBe(true);
    const p = (o: Record<string, unknown>, r = req(CELL, 'fill')) =>
      parseSpreadCandidate(world, r, raw(o), 0);
    expect(p({ name: '  ' })).toBeNull();
    expect(p({ name: 'Cloud Anklet' })).toBeNull(); // taken
    expect(p({ name: 'cloud-anklet!' })).toBeNull(); // taken, after normalising
    expect(p({ kind: 'creature' })).toBeNull(); // a cell fixes the kind
    expect(
      p({ kind: 'creature' }, req({ type: 'selection', entities: ['glide', 'reef-ray'] }, 'vary'))
        ?.kind,
    ).toBe('creature');
    expect(parseSpreadCandidate(world, req(CELL, 'fill'), 'nope', 0)).toBeNull();
    expect(p({ attributes: { weight: 3, x: 'no' } })?.attributes).toEqual({ weight: 3 });
    expect(p({ position: null })?.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('sets about for Ground, Cost and Name, and nulls the kind of findings', () => {
    const g = parseSpreadCandidate(
      world,
      req(ANKLET, 'ground'),
      raw({ about: 'ghost', name: 'Coral-bound' }),
      0,
    );
    expect(g?.about).toBe('cloud-anklet');
    expect(g?.kind).toBe('item');
    const sel = req({ type: 'selection', entities: ['glide', 'reef-ray'] }, 'name');
    expect(
      parseSpreadCandidate(world, sel, raw({ about: 'reef-ray', name: 'Sky Manta' }), 0),
    ).toMatchObject({ about: 'reef-ray', kind: 'creature' });
    expect(parseSpreadCandidate(world, sel, raw({ about: null, name: 'Sky Manta' }), 0)).toBeNull();
    // A rename may keep its own name's letters but not take another's.
    expect(parseSpreadCandidate(world, req(ANKLET, 'name'), raw({ name: 'Glide' }), 0)).toBeNull();
    expect(
      parseSpreadCandidate(world, req(ANKLET, 'name'), raw({ name: 'Cloud anklet' }), 0)?.name,
    ).toBe('Cloud anklet');
    const f = parseSpreadCandidate(
      world,
      req(ANKLET, 'break'),
      raw({
        name: 'Glide loop',
        relations: [
          { type: 'pairs_with', target: 'glide' },
          { type: 'zzz', target: 'glide' },
        ],
      }),
      0,
    );
    expect(f).toMatchObject({
      kind: null,
      fields: {},
      attributes: {},
      relations: [{ type: 'pairs_with', target: 'glide' }],
    });
    expect(
      parseSpreadCandidate(world, req(ANKLET, 'break'), raw({ name: 'Cloud Anklet' }), 0)?.name,
    ).toBe('Cloud Anklet');
  });

  it('parses a whole output: unique names, the count, exactly one wildcard, the requested axes', () => {
    const list = [
      raw(),
      raw(),
      raw({ name: 'Ash Coat' }),
      raw({ name: 'Thorn Bell', wildcard: true }),
      raw({ name: 'Iron Reed', wildcard: true }),
      raw({ name: 'Extra' }),
    ];
    const r = parseSpreadOutput(world, req(CELL, 'fill', { count: 4 }), {
      axes: { x: { label: 'a', low: 'b', high: 'c' } },
      candidates: list,
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.result.candidates.map((c) => [c.key, c.name, c.wildcard])).toEqual([
      ['c1', 'Glass Lung', false],
      ['c3', 'Ash Coat', false],
      ['c4', 'Thorn Bell', true],
    ]);
    expect(r.value.dropped).toBe(3); // a duplicate, then everything after the first 4
    expect(
      parseSpreadCandidate(world, req(CELL, 'fill', { count: 4 }), raw({ name: 'Late' }), 4),
    ).toBeNull();
    expect(r.value.result.axes).toEqual(MOVE_DEFS.fill.axes); // invalid axes → the move's default
    const axes = {
      x: { label: 'menace', low: 'l', high: 'h' },
      y: { label: 'scale', low: 'l', high: 'h' },
    };
    const r2 = parseSpreadOutput(world, req(CELL, 'fill', { axes }), { candidates: [raw()] });
    expect(r2.ok && r2.value.result).toMatchObject({ axes, candidates: [{ wildcard: true }] });
    expect(parseSpreadOutput(world, req(CELL, 'fill'), { axes: {} })).toMatchObject({
      ok: false,
      error: { code: 'invalid_output' },
    });
  });

  it('property: any output parses to a valid result whose candidates can all be kept', () => {
    const anyJson = fc.jsonValue({ maxDepth: 3 });
    const candArb = fc.record(
      {
        kind: fc.constantFrom('item', 'creature', null, 'nonsense', 3),
        name: fc.oneof(
          fc.string({ maxLength: 20 }),
          fc.constantFrom('Cloud Anklet', 'Glass Lung', 'Ash Coat'),
        ),
        identity: fc.oneof(fc.string({ maxLength: 40 }), anyJson),
        fields: fc.oneof(
          fc.record({
            subkind: fc.constantFrom('accessory', 'mythic', 7),
            route: fc.constantFrom([{ text: 'x', needs: ['sky-coral', 'ghost'] }], 'bad'),
          }),
          anyJson,
        ),
        relations: fc.array(
          fc.record({
            type: fc.constantFrom('made_from', 'in_band', 'pairs_with', 'x'),
            target: fc.constantFrom('sky-coral', 'low-sky', 'glide', 'ghost', 'cloud-anklet'),
          }),
          { maxLength: 4 },
        ),
        attributes: fc.oneof(
          fc.array(
            fc.record({ key: fc.constantFrom('defense', 'weight', 'Bad'), value: fc.double() }),
            { maxLength: 3 },
          ),
          anyJson,
        ),
        about: fc.constantFrom(null, 'cloud-anklet', 'ghost'),
        position: fc.oneof(fc.record({ x: fc.double(), y: fc.double() }), anyJson),
        wildcard: fc.oneof(fc.boolean(), anyJson),
      },
      { requiredKeys: [] },
    );
    const spots: [Spot, Move][] = [
      [CELL, 'fill'],
      [ANKLET, 'vary'],
      [ANKLET, 'ground'],
      [ANKLET, 'cost'],
      [ANKLET, 'break'],
      [{ type: 'selection', entities: ['glide', 'cloud-anklet'] }, 'alloy'],
    ];
    fc.assert(
      fc.property(
        fc.array(candArb, { maxLength: 8 }),
        fc.integer({ min: 0, max: spots.length - 1 }),
        (cands, si) => {
          const [spot, move] = spots[si]!;
          const r = req(spot, move);
          const out = parseSpreadOutput(world, r, { candidates: cands });
          if (!out.ok) throw new Error(out.error.message);
          const result = SpreadResultSchema.parse(out.value.result);
          expect(result.candidates.length + out.value.dropped).toBe(cands.length);
          if (result.candidates.length > 0)
            expect(result.candidates.filter((c) => c.wildcard)).toHaveLength(1);
          const spread = makeSpread({
            id: 's',
            now: SAMPLE_TIME,
            request: { spot, move, count: 16, axes: result.axes, ruleIds: [] },
            candidates: result.candidates,
            status: 'done',
          });
          const saved = applyCommand(world, cmd('spread.save', { record: spread }), {
            now: SAMPLE_TIME,
          });
          if (!saved.ok) throw new Error(saved.error.message);
          for (const c of result.candidates) {
            const t = keepCommands(saved.value.world, spread, c.key);
            if (!t.ok) throw new Error(t.error.message);
            const applied = applyCommands(saved.value.world, t.value.commands, {
              now: SAMPLE_TIME,
            });
            if (!applied.ok) throw new Error(`${c.name}: ${applied.error.message}`);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('parsing patterns', () => {
  it('keeps at most five valid patterns and resolves updates', () => {
    const w = sampleWorld();
    w.taste.patterns = [{ id: 'pat-1', text: 'Old.', status: 'proposed', examples: [] }];
    const r = parsePatternsOutput(w, {
      patterns: [
        { text: 'A', examples: ['x', 'x', 3], strength: 2, updates: 'pat-1' },
        { text: '', strength: 0.5 },
        { text: 'B', strength: 'high' },
        { text: 'C', strength: 0.3, updates: 'pat-9' },
        ...['D', 'E', 'F', 'G'].map((t) => ({ text: t, strength: 0.1, examples: [] })),
      ],
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.result.patterns.map((p) => p.text)).toEqual(['A', 'C', 'D', 'E', 'F']);
    expect(r.value.result.patterns[0]).toEqual({
      text: 'A',
      examples: ['x'],
      strength: 1,
      updates: 'pat-1',
    });
    expect(r.value.result.patterns[1]?.updates).toBeUndefined();
    expect(r.value.dropped).toBe(3);
    expect(PatternsResultSchema.safeParse(r.value.result).success).toBe(true);
    expect(parsePatternsOutput(w, {})).toMatchObject({ ok: false });
  });
});

describe('the builders, wired to an assemble()', () => {
  const calls: AssembleLike<{ effort: string }>[] = [];
  const assemble = (input: AssembleLike<{ effort: string }>) => {
    calls.push(input);
    return { system: input.instructions, user: input.ask };
  };
  const [spread, patterns] = createSpreadPromptBuilders(assemble);

  it('builds a spread with the packer focus, the ask and the schema', () => {
    const r = spread.build(
      world,
      req(CELL, 'fill', { direction: 'lighter', ruleIds: ['no-pure-numbers'] }),
      { effort: 'low' },
    );
    expect(r.ok).toBe(true);
    const input = calls.at(-1)!;
    expect(input.moment).toBe('spread');
    expect(input.focus).toEqual({ entities: [], band: 'low-sky', lane: 'items' });
    expect(input.ask).toContain('Direction from the designer: lighter');
    expect(input.ask).toContain('Diversity contract:');
    expect(input.ask).not.toContain('<entity id="low-sky"'); // the packer renders entities
    expect(input.pack).toEqual({ taste: { ruleIds: ['no-pure-numbers'] } });
    expect(input.options).toEqual({ effort: 'low' });
    expect(input.defaults.stream).toBe(true);
    expect(spread.build(world, req(ANKLET, 'vary')).ok && calls.at(-1)?.entity).toBe(
      'cloud-anklet',
    );
    expect(spread.build(world, req({ type: 'entity', entity: 'ghost' }, 'vary'))).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(spread.build(world, req(CELL, 'vary'))).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(spread.build(world, { bogus: 1 } as never)).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('streams items with the same keys the final parse gives', () => {
    const r = req(CELL, 'fill');
    const items = [raw(), raw({ name: 'Ash Coat' })];
    const streamed = items.map((x, i) => spread.stream.item(x, i, world, r));
    const final = spread.parse({ candidates: items }, world, r);
    expect(final.ok && final.value.result.candidates.map((c) => c.key)).toEqual(
      streamed.map((c) => c?.key),
    );
  });

  it('builds and parses patterns', () => {
    const r = patterns.build(world, {
      judgements: [
        {
          candidate: { name: 'A', identity: 'a', kind: 'item' },
          verdict: 'kill',
          reason: 'off-tone',
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(calls.at(-1)?.ask).toContain('- KILL A (item): a — reason: off-tone');
    expect(calls.at(-1)?.pack).toEqual({ budget: 20_000 });
    expect(patterns.build(world, { judgements: [] })).toMatchObject({ ok: false });
    expect(
      patterns.parse({ patterns: [{ text: 'X', strength: 0.5, examples: [] }] }, world).ok,
    ).toBe(true);
  });

  it('maps spots to packer focus and asks without entity renders', () => {
    expect(
      spotFocusOf({
        type: 'region',
        band: 'hollows',
        climate: { temperature: { min: 0, max: 1 }, moisture: { min: 0, max: 1 } },
      }),
    ).toEqual({ entities: [], band: 'hollows', kind: 'biome' });
    expect(spotFocusOf({ type: 'note', note: 'x', entities: ['glide'] })).toEqual({
      entities: ['glide'],
    });
    expect(spotFocusOf({ type: 'selection', entities: ['glide'] })).toEqual({
      entities: ['glide'],
    });
    expect(spreadAsk(world, req(ANKLET, 'vary'))).not.toContain('In focus:');
  });
});
