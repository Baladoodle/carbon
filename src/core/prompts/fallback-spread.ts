import { AxisSchema, MOVES, type Candidate, type Move, type Spot } from '../ai/moments';
import { z } from 'zod';
import type { Focus } from '../context/relevance';
import { ENTITY_KINDS, LANE_OF_KIND, type EntityKind } from '../model/kinds';
import { getEntity, schemaOf, type World } from '../model/world';
import { err, ok } from '../util/result';
import { assemble } from './common';
import { arr, bool, duplicatesName, enumOf, normName, nullable, num, obj, str } from './schema';
import type { ParsedRequest, PromptBuilder } from './types';

/**
 * FALLBACK builders for `spread` and `patterns`. Package W5 owns these moments
 * and registers its own builders, which replace these (see registry.ts). They
 * exist so the gateway's streaming path, the evals' spread-diversity metric and
 * the real smoke test work before W5 is merged. Keep them simple.
 */

const MOVE_ASKS: Record<Move, string> = {
  fill: 'candidates for this empty spot, built to fit their neighbours',
  vary: 'siblings of the entity: the same role, a different identity',
  oppose: 'the strongest inversions of the entity or rule',
  alloy: 'combinations of the entities into something neither is',
  push: 'the same thing at 10× strength, weirdness or cost',
  ground: 'ties of the entity to bands, biomes, materials and creatures, each with a reason',
  cost: '2 or 3 acquisition routes with their total effort',
  break: 'exploits, degenerate combinations and trivialised bands (findings, not entities)',
  name: 'a naming pass in the world’s own voice',
};

export function spotKind(world: World, spot: Spot, move: Move): EntityKind | null {
  if (move === 'break') return null;
  switch (spot.type) {
    case 'cell':
      return ENTITY_KINDS.find((k) => LANE_OF_KIND[k] === spot.lane) ?? null;
    case 'region':
      return 'biome';
    case 'entity':
      return getEntity(world, spot.entity)?.kind ?? null;
    case 'selection':
    case 'note': {
      const first = spot.entities[0];
      return (first ? getEntity(world, first)?.kind : undefined) ?? null;
    }
  }
}

export function spotFocus(spot: Spot): Focus {
  switch (spot.type) {
    case 'cell':
      return { entities: [], band: spot.band, lane: spot.lane };
    case 'region':
      return { entities: [], band: spot.band, kind: 'biome' };
    case 'entity':
      return { entities: [spot.entity] };
    case 'selection':
    case 'note':
      return { entities: spot.entities };
  }
}

const SPREAD_INSTRUCTIONS = `# Moment: spread

The designer started a spread: a spot, a move and an optional direction. Generate candidates for them to triage (keep, kill, merge).
- Every candidate must fit the spot and the world, and be meaningfully different from every other candidate and from every existing entity. Never reuse an existing name.
- Spread them across the two axes: positions should cover the field, not cluster.
- The LAST candidate is the wildcard: generate it ignoring the designer's Rules (still the world's voice), and set wildcard true. All others have wildcard false and obey the Rules.
- relations: only ids from the context, only relation types from the list below.
- about: for moves that change an existing entity (ground, cost, name), that entity's id; otherwise null.
- rationale: at most 15 words.
- Write "axes" first, then candidates one by one.`;

function candidateSchema(world: World) {
  const schema = schemaOf(world);
  return obj({
    kind: nullable(enumOf(ENTITY_KINDS)),
    name: str(),
    identity: str(),
    description: str(),
    attributes: arr(obj({ key: str(), value: num() })),
    relations: arr(
      obj({ type: enumOf(Object.keys(schema.relations).sort()), target: str(), note: str() }),
    ),
    about: nullable(str()),
    position: obj({ x: num('0..1'), y: num('0..1') }),
    wildcard: bool(),
    rationale: str(),
  });
}

function parseCandidate(
  world: World,
  req: ParsedRequest<'spread'>,
  raw: unknown,
  index: number,
): Candidate | null {
  const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!x) return null;
  const expected = spotKind(world, req.spot, req.move);
  const kind = (x.kind ?? null) as EntityKind | null;
  if (kind !== null && !(ENTITY_KINDS as readonly string[]).includes(kind)) return null;
  if (expected !== null && kind !== null && kind !== expected && req.spot.type === 'cell')
    return null;
  const name = typeof x.name === 'string' ? x.name.trim() : '';
  if (name === '' || (kind !== null && duplicatesName(world, name))) return null;
  const schema = schemaOf(world);
  const relations = (Array.isArray(x.relations) ? x.relations : [])
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .filter((r) => {
      const def = typeof r.type === 'string' ? schema.relations[r.type] : undefined;
      const target = typeof r.target === 'string' ? getEntity(world, r.target) : undefined;
      if (!def || !target || kind === null) return false;
      const okFrom = def.from === '*' || def.from.includes(kind);
      const okTo = def.to === '*' || def.to.includes(target.kind);
      return okFrom && okTo;
    })
    .map((r) => ({
      type: r.type as string,
      target: r.target as string,
      ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim() } : {}),
    }));
  const attributes: Record<string, number> = {};
  for (const a of Array.isArray(x.attributes) ? x.attributes : []) {
    const at = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
    if (
      typeof at.key === 'string' &&
      /^[a-z][a-z0-9_]*$/.test(at.key) &&
      typeof at.value === 'number' &&
      Number.isFinite(at.value)
    )
      attributes[at.key] = at.value;
  }
  const pos =
    x.position && typeof x.position === 'object' ? (x.position as Record<string, unknown>) : {};
  const clamp = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  const about = typeof x.about === 'string' && getEntity(world, x.about) ? x.about : undefined;
  return {
    key: `c${index + 1}`,
    kind,
    name,
    identity: typeof x.identity === 'string' ? x.identity.trim() : '',
    ...(typeof x.description === 'string' && x.description.trim()
      ? { description: x.description.trim() }
      : {}),
    fields: {},
    attributes,
    relations,
    ...(about ? { about } : {}),
    position: { x: clamp(pos.x), y: clamp(pos.y) },
    wildcard: x.wildcard === true,
    ...(typeof x.rationale === 'string' && x.rationale.trim()
      ? { rationale: x.rationale.trim() }
      : {}),
  };
}

export const fallbackSpreadBuilder: PromptBuilder<'spread'> = {
  moment: 'spread',
  defaults: { effort: 'medium', maxTokens: 32000, stream: true },
  build(world, req, options) {
    const ids =
      req.spot.type === 'cell' || req.spot.type === 'region'
        ? [req.spot.band]
        : req.spot.type === 'entity'
          ? [req.spot.entity]
          : req.spot.entities;
    const missing = ids.filter((id) => !getEntity(world, id));
    if (missing.length > 0) return err('not_found', `no entity "${missing.join('", "')}"`);
    if (!(MOVES as readonly string[]).includes(req.move))
      return err('bad_request', `unknown move ${req.move}`);
    const kind = spotKind(world, req.spot, req.move);
    const schema = schemaOf(world);
    const relationList = Object.values(schema.relations)
      .sort((a, b) => a.type.localeCompare(b.type))
      .map(
        (r) =>
          `- ${r.type}: ${r.from === '*' ? 'any' : r.from.join('/')} → ${r.to === '*' ? 'any' : r.to.join('/')}`,
      )
      .join('\n');
    const spotText =
      req.spot.type === 'cell'
        ? `the ${req.spot.lane} lane of band ${req.spot.band}`
        : req.spot.type === 'region'
          ? `the climate region temperature ${req.spot.climate.temperature.min}..${req.spot.climate.temperature.max}, moisture ${req.spot.climate.moisture.min}..${req.spot.climate.moisture.max} of band ${req.spot.band}`
          : req.spot.type === 'entity'
            ? `the entity ${req.spot.entity}`
            : `the entities ${req.spot.entities.join(', ')}`;
    const ask = [
      `Spot: ${spotText}`,
      `Move: ${req.move}: ${MOVE_ASKS[req.move]}`,
      ...(req.direction ? [`Direction: ${req.direction}`] : []),
      kind
        ? `Candidates are ${schema.kinds[kind].plural.toLowerCase()} (kind "${kind}").`
        : 'Candidates are findings: kind null.',
      req.axes
        ? `Axes: x = ${req.axes.x.label} (${req.axes.x.low} → ${req.axes.x.high}); y = ${req.axes.y.label} (${req.axes.y.low} → ${req.axes.y.high}). Use exactly these.`
        : 'Choose two axes that separate the candidates in ways the designer cares about.',
      `Generate ${req.count} candidates.`,
      '',
      'Relation types:',
      relationList,
    ].join('\n');
    const axis = obj({ label: str(), low: str(), high: str() });
    return ok(
      assemble({
        moment: 'spread',
        world,
        focus: spotFocus(req.spot),
        instructions: SPREAD_INSTRUCTIONS,
        ask,
        schema: obj({ axes: obj({ x: axis, y: axis }), candidates: arr(candidateSchema(world)) }),
        defaults: this.defaults,
        ...(options ? { options } : {}),
        ...(req.spot.type === 'entity' ? { entity: req.spot.entity } : {}),
        pack: { taste: req.ruleIds ? { ruleIds: req.ruleIds } : {} },
      }),
    );
  },
  stream: {
    arrayKey: 'candidates',
    item: (raw, index, world, req) => parseCandidate(world, req, raw, index),
  },
  parse(raw, world, req) {
    const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const axes = z.object({ x: AxisSchema, y: AxisSchema }).safeParse(x.axes);
    const list = Array.isArray(x.candidates) ? x.candidates : null;
    if (!list || (!axes.success && !req.axes))
      return err('invalid_output', 'no axes or candidates');
    let dropped = 0;
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    list.forEach((c, i) => {
      const p = parseCandidate(world, req, c, i);
      if (!p || seen.has(normName(p.name))) dropped++;
      else {
        seen.add(normName(p.name));
        candidates.push(p);
      }
    });
    // Exactly one wildcard: the first marked one, else the last candidate.
    const first = candidates.findIndex((c) => c.wildcard);
    candidates.forEach(
      (c, i) => (c.wildcard = first >= 0 ? i === first : i === candidates.length - 1),
    );
    const chosen = req.axes ?? (axes.success ? axes.data : undefined);
    if (!chosen) return err('invalid_output', 'no axes');
    return ok({ result: { axes: chosen, candidates }, dropped });
  },
};

const PATTERNS_INSTRUCTIONS = `# Moment: patterns

From the designer's recent judgements of spread candidates (keeps and kills, with kill reasons), find the patterns in their taste: what they consistently keep and what they consistently reject.
- Each pattern is one sentence a designer would recognise as true of themselves, specific to this world, usable as a rule.
- examples: names of candidates that show it.
- strength: 0..1, how consistently the judgements show it.
- updates: the id of an existing pattern this refines (ids in brackets under Patterns), or null.
- Only patterns with at least two supporting judgements. At most 5.`;

export const fallbackPatternsBuilder: PromptBuilder<'patterns'> = {
  moment: 'patterns',
  defaults: { effort: 'medium', maxTokens: 8000, stream: false },
  build(world, req, options) {
    const existing = world.taste.patterns
      .map((p) => `- [${p.id}] ${p.text} (${p.status})`)
      .join('\n');
    const ask = [
      'Judgements:',
      ...req.judgements.map(
        (j) =>
          `- ${j.verdict.toUpperCase()} ${j.candidate.kind ?? 'finding'} "${j.candidate.name}": ${j.candidate.identity}${j.reason ? ` (reason: ${j.reason})` : ''}`,
      ),
      ...(existing ? ['', 'Existing patterns:', existing] : []),
      '',
      'Find the patterns.',
    ].join('\n');
    return ok(
      assemble({
        moment: 'patterns',
        world,
        focus: { entities: [] },
        instructions: PATTERNS_INSTRUCTIONS,
        ask,
        schema: obj({
          patterns: arr(
            obj({
              text: str(),
              examples: arr(str()),
              strength: num('0..1'),
              updates: nullable(str()),
            }),
          ),
        }),
        defaults: this.defaults,
        ...(options ? { options } : {}),
        pack: { budget: 20_000 },
      }),
    );
  },
  parse(raw, world) {
    const list =
      raw && typeof raw === 'object' ? (raw as { patterns?: unknown }).patterns : undefined;
    if (!Array.isArray(list)) return err('invalid_output', 'no patterns list');
    let dropped = 0;
    const patterns = list.flatMap((p) => {
      const x = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
      const text = typeof x.text === 'string' ? x.text.trim() : '';
      if (text === '' || typeof x.strength !== 'number' || !Number.isFinite(x.strength)) {
        dropped++;
        return [];
      }
      const updates =
        typeof x.updates === 'string' && world.taste.patterns.some((q) => q.id === x.updates)
          ? x.updates
          : undefined;
      return [
        {
          text,
          examples: Array.isArray(x.examples)
            ? x.examples.filter((e): e is string => typeof e === 'string')
            : [],
          strength: Math.min(1, Math.max(0, x.strength)),
          ...(updates ? { updates } : {}),
        },
      ];
    });
    return ok({ result: { patterns }, dropped });
  },
};
