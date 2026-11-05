import { imagePromptBuilder } from '../images/prompt';
import { describe, expect, it } from 'vitest';
import { CRITIQUE_KINDS, MOMENT_SCHEMAS, MOVES, type Spot } from '../ai/moments';
import { sampleWorld } from '../testing/sample';
import { checkSpot } from '../spreads/spot';
import { parseSpreadCandidate } from '../spreads/builders';
import { buildSpreadPrompt } from '../spreads/prompt';
import { promptText } from './common';
import { CRITIQUE_INSTRUCTIONS } from './critique';
import { fillBuilder } from './fill';
import {
  critiqueRubric,
  isJustANumber,
  QUALITY,
  qualityConstraints,
  selfCheck,
  selfCheckCandidate,
} from './quality';
import { createPromptRegistry } from './registry';
import { suggestOneBuilder, suggestThreeBuilder } from './suggest';

const world = sampleWorld();
const registry = createPromptRegistry();

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

/** The criterion kinds a prompt text lists under a heading, as `- kind: …` lines after it. */
function kindsUnder(text: string, heading: RegExp): string[] {
  const at = text.search(heading);
  if (at < 0) return [];
  const rest = text.slice(at).split('\n').slice(1);
  const out: string[] = [];
  let started = false;
  for (const line of rest) {
    const m = /^- ([a-z_]+): /.exec(line);
    if (m) {
      started = true;
      out.push(m[1]!);
    } else if (started) break;
  }
  return out;
}

const CRITIC = /return notes ONLY for real problems of these kinds:/;
const WRITER = /# Quality bar \(must satisfy\)/;

/** Every generating prompt: suggest one and three, fill, and a spread for every move. */
function generatingPrompts(): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const one = ok(
    suggestOneBuilder.build(
      world,
      MOMENT_SCHEMAS.suggest_one.request.parse({ entityId: 'glide', field: 'identity' }),
    ),
  );
  out.push({ id: 'suggest_one', text: promptText(one) });
  const three = ok(
    suggestThreeBuilder.build(
      world,
      MOMENT_SCHEMAS.suggest_three.request.parse({ entityId: 'glide', field: 'name' }),
    ),
  );
  out.push({ id: 'suggest_three', text: promptText(three) });
  out.push({
    id: 'fill_entity',
    text: promptText(ok(fillBuilder.build(world, { entityId: 'high-drift' }))),
  });
  const spots: Spot[] = [
    { type: 'cell', band: 'hollows', lane: 'creatures' },
    { type: 'entity', entity: 'cloud-anklet' },
    { type: 'selection', entities: ['glide', 'cloud-anklet'] },
  ];
  const spread = registry.get('spread')!;
  for (const move of MOVES) {
    const spot = spots.find((s) => checkSpot(world, s, move).ok);
    expect(spot, `a spot for ${move}`).toBeDefined();
    const req = MOMENT_SCHEMAS.spread.request.parse({ spot, move });
    out.push({ id: `spread:${move}`, text: promptText(ok(spread.build(world, req))) });
    // The plain five-part spread prompt (tests, evals without the packer) too.
    const parts = buildSpreadPrompt(world, req);
    out.push({ id: `spread-parts:${move}`, text: Object.values(parts).join('\n\n') });
  }
  // images-core: the image prompt carries the bar too (only two criteria apply; its exception line says so).
  out.push({
    id: 'image_prompt',
    text: promptText(
      ok(imagePromptBuilder.build(world, { entityId: 'cloud-reef', kind: 'concept' })),
    ),
  });
  return out;
}

describe('one quality bar for the critic and every writer', () => {
  it('has one criterion per critique kind, in the critic’s order', () => {
    expect(QUALITY.map((c) => c.kind)).toEqual([...CRITIQUE_KINDS]);
    for (const c of QUALITY) {
      expect(c.rubric.length, c.kind).toBeGreaterThan(20);
      expect(c.must.length, c.kind).toBeGreaterThan(20);
    }
  });

  it('the critic judges by exactly the criteria every generating prompt must satisfy', () => {
    // Read back from the prompts as sent, not from the table: a line added by
    // hand to one side (or a criterion missing from one) fails here.
    const critic = kindsUnder(CRITIQUE_INSTRUCTIONS, CRITIC);
    expect(critic).toEqual([...CRITIQUE_KINDS]);
    const critique = ok(
      registry.get('critique')!.build(world, { entityId: 'glide', trigger: 'on_demand' }),
    );
    expect(kindsUnder(promptText(critique), CRITIC)).toEqual(critic);
    const prompts = generatingPrompts();
    expect(prompts.length).toBe(4 + MOVES.length * 2);
    for (const p of prompts) {
      expect(kindsUnder(p.text, WRITER), p.id).toEqual(critic);
      for (const c of QUALITY) expect(p.text, `${p.id} › ${c.kind}`).toContain(c.must);
    }
    for (const c of QUALITY) expect(CRITIQUE_INSTRUCTIONS).toContain(c.rubric);
  });

  it('renders the two views from the same table', () => {
    expect(critiqueRubric().split('\n')).toHaveLength(QUALITY.length);
    const block = qualityConstraints('Every value', 'One exception.');
    expect(block.startsWith('# Quality bar (must satisfy)')).toBe(true);
    expect(block).toContain('Every value must satisfy all of them');
    expect(block.endsWith('One exception.')).toBe(true);
  });

  it('tells the critic which fields the AI wrote', () => {
    const w = structuredClone(world);
    w.entities.glide!.ai_fields = ['verb', 'identity'];
    const p = ok(registry.get('critique')!.build(w, { entityId: 'glide', trigger: 'on_demand' }));
    expect(p.user.at(-1)!.text).toContain(
      'Fields written by the AI and not edited since: identity, verb',
    );
    const plain = ok(
      registry.get('critique')!.build(world, { entityId: 'glide', trigger: 'on_demand' }),
    );
    expect(plain.user.at(-1)!.text).not.toContain('Fields written by the AI');
  });

  it('a suggestion carries a critique note as guidance, additively', () => {
    const req = MOMENT_SCHEMAS.suggest_one.request.parse({
      entityId: 'glide',
      field: 'identity',
      guidance: 'Glide needs a sharper one-line identity.',
    });
    const ask = ok(suggestOneBuilder.build(world, req)).user.at(-1)!.text;
    expect(ask).toContain('"Glide needs a sharper one-line identity."');
    expect(ask.trim().endsWith('Suggest one value for this field.')).toBe(true);
    const plain = MOMENT_SCHEMAS.suggest_one.request.parse({
      entityId: 'glide',
      field: 'identity',
    });
    expect(plain).not.toHaveProperty('guidance');
    expect(ok(suggestOneBuilder.build(world, plain)).user.at(-1)!.text).not.toContain('critic');
  });
});

describe('the deterministic self-check', () => {
  it('knows a pure-number identity from one with numbers in it', () => {
    for (const t of ['+10% damage', 'Grants 5 extra defense.', '×2 speed', '10% faster', '+3 HP'])
      expect(isJustANumber(t), t).toBe(true);
    for (const t of [
      'Lasts 10 seconds, then shatters.',
      'Fall slowly, steer the fall.',
      '+10% damage while you are falling',
      'Damage',
      '',
    ])
      expect(isJustANumber(t), t).toBe(false);
  });

  it('flags a duplicate name or identity, and a pure-number identity', () => {
    expect(selfCheck(world, 'name', 'glide ', 'cloud-anklet')).toBe('duplicate');
    expect(selfCheck(world, 'name', 'Glide', 'glide')).toBeNull();
    expect(selfCheck(world, 'identity', 'Fall slowly, steer the fall!', 'cloud-anklet')).toBe(
      'duplicate',
    );
    expect(selfCheck(world, 'identity', 'Fall slowly, steer the fall.', 'glide')).toBeNull();
    expect(selfCheck(world, 'identity', '+10% damage', 'glide')).toBe('just_a_number');
    expect(selfCheck(world, 'description', '+10% damage', 'glide')).toBeNull();
    expect(selfCheck(world, 'tradeoff', 42, 'glide')).toBeNull();
    expect(selfCheckCandidate(world, { name: 'New Thing', identity: '+5 defense' })).toBe(
      'just_a_number',
    );
    expect(
      selfCheckCandidate(world, { name: 'New Thing', identity: 'Hums near vents.' }),
    ).toBeNull();
  });

  it('fill drops a proposal the critic would flag at once, and counts it', () => {
    const w = structuredClone(world);
    w.entities['high-drift']!.identity = '';
    const out = ok(
      fillBuilder.parse(
        {
          proposals: {
            identity: { value: '+10% speed', note: null },
            character: { value: 'Silent and cold', note: null },
          },
        },
        w,
        { entityId: 'high-drift' },
      ),
    );
    expect(out.dropped).toBe(1);
    expect(out.result.proposals.map((p) => p.field)).toEqual(['character']);
  });

  it('suggest drops a suggestion the critic would flag at once', () => {
    const req = MOMENT_SCHEMAS.suggest_one.request.parse({ entityId: 'glide', field: 'identity' });
    expect(
      suggestOneBuilder.parse({ suggestion: { value: '+10% damage', note: 'x' } }, world, req),
    ).toMatchObject({ ok: false, error: { code: 'invalid_output' } });
    // Another entity's identity is a duplicate.
    expect(
      suggestOneBuilder.parse(
        { suggestion: { value: 'Light that breathes.', note: 'x' } },
        world,
        req,
      ),
    ).toMatchObject({ ok: false });
    const three = suggestThreeBuilder.parse(
      {
        suggestions: [
          { value: 'Ride the vents down.', note: 'a' },
          { value: '+5 defense', note: 'b' },
          { value: 'Steer by the cloud below.', note: 'c' },
          { value: 'Fold your coat to drop.', note: 'd' },
        ],
      },
      world,
      req,
    );
    expect(ok(three).dropped).toBe(1);
    expect(ok(three).result.suggestions.map((s) => s.value)).not.toContain('+5 defense');
  });

  it('a spread drops a candidate the critic would flag at once (counted by the parser)', () => {
    const req = MOMENT_SCHEMAS.spread.request.parse({
      spot: { type: 'cell', band: 'hollows', lane: 'creatures' },
      move: 'fill',
    });
    const cand = (name: string, identity: string) => ({
      kind: 'creature',
      name,
      identity,
      position: { x: 0.5, y: 0.5 },
    });
    expect(parseSpreadCandidate(world, req, cand('Moss Hopper', '+10% damage'), 0)).toBeNull();
    expect(
      parseSpreadCandidate(world, req, cand('Moss Hopper', 'A slow, glowing herd animal.'), 0),
    ).toBeNull();
    expect(
      parseSpreadCandidate(world, req, cand('Moss Hopper', 'Hops between glowing pools.'), 0),
    ).not.toBeNull();
  });
});
