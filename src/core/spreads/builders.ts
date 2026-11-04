import { z } from 'zod';
import type { Candidate, MomentResult, Spot, MOMENT_SCHEMAS } from '../ai/moments';
import { AxisSchema, PatternsResultSchema, SpreadRequestSchema } from '../ai/moments';
import type { FieldDef } from '../model/fields';
import type { EntityId } from '../model/ids';
import { ENTITY_KINDS, type EntityKind, type Lane } from '../model/kinds';
import { getEntity, schemaOf, type World } from '../model/world';
import { err, ok, type Result } from '../util/result';
import { patternsFocus, PATTERNS_SYSTEM, PATTERNS_TASK } from '../taste/prompt';
import { MOVE_DEFS } from './moves';
import { SPREAD_SYSTEM, spreadFocus, spreadTask } from './prompt';
import { checkSpot, spotEntities, spotKind } from './spot';
import { cleanAttributes, cleanFields, cleanRelations } from './triage';

/**
 * The `spread` and `patterns` prompt builders in the shape of W4's
 * `PromptBuilder` (src/core/prompts/types.ts on the ai branch): `build`,
 * `parse` and, for spreads, `stream.item`. Everything here is pure.
 *
 * `build` needs W4's `assemble()` (context packer + the shared cached
 * layout), which isn't on this branch, so it's injected:
 *
 *   // src/core/prompts/registry.ts, at integration:
 *   import { createSpreadPromptBuilders } from '../spreads/builders';
 *   export const PACKAGE_BUILDERS = [...createSpreadPromptBuilders(assemble)];
 *
 * The layout it produces: role · digest⟂ · taste⟂ · instructions⟂ | focus ·
 * ask, where `instructions` is the static spread (or patterns) system text and
 * `ask` is the spot, kind schema, direction and the move's task, ending with
 * the diversity contract. `buildSpreadPrompt` (prompt.ts) is the same content
 * as five plain strings, for tests and evals without the packer.
 */

type SpreadReq = z.output<typeof MOMENT_SCHEMAS.spread.request>;
type PatternsReq = z.output<typeof MOMENT_SCHEMAS.patterns.request>;
type Json = { [key: string]: unknown };

/** The packer focus for a spot (W4's `Focus`). */
export interface FocusLike {
  entities: readonly EntityId[];
  band?: EntityId;
  lane?: Lane;
  kind?: EntityKind;
}

/** What W4's `assemble()` takes (structurally). `O` is W4's `BuildOptions`. */
export interface AssembleLike<O> {
  moment: 'spread' | 'patterns';
  world: World;
  focus: FocusLike;
  instructions: string;
  ask: string;
  schema: Json;
  defaults: { effort: 'medium'; maxTokens: number; stream: boolean };
  options?: O;
  entity?: EntityId;
  pack?: { budget?: number; taste?: { ruleIds?: string[] } };
}

// ── JSON Schema for structured outputs ──────────────────────────────────────
// Every object closes (additionalProperties: false) and requires every key;
// optional values are `anyOf [T, null]` (what structured outputs need).

const str = (description?: string): Json => ({
  type: 'string',
  ...(description ? { description } : {}),
});
const num = (description?: string): Json => ({
  type: 'number',
  ...(description ? { description } : {}),
});
const bool = (): Json => ({ type: 'boolean' });
const arr = (items: Json): Json => ({ type: 'array', items });
const nullable = (s: Json): Json => ({ anyOf: [s, { type: 'null' }] });
const enumOf = (values: readonly string[]): Json => ({ type: 'string', enum: [...values] });
const obj = (properties: Record<string, Json>): Json => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** The JSON Schema of one kind field's value. */
export function fieldJson(world: World, def: FieldDef): Json {
  const range = obj({ min: num(), max: num() });
  switch (def.type) {
    case 'text':
    case 'longtext':
      return str(def.help);
    case 'number':
      return num(
        def.min !== undefined || def.max !== undefined
          ? `${def.min ?? '-∞'}..${def.max ?? '∞'}`
          : def.help,
      );
    case 'range':
      return range;
    case 'enum':
      return def.options && def.options.length > 0 ? enumOf(def.options) : str();
    case 'list':
      return arr(str());
    case 'height':
      return { anyOf: [num(), enumOf(['-inf', '+inf'])] };
    case 'ref': {
      const ids = Object.values(world.entities)
        .filter((e) => !def.refKinds || def.refKinds.includes(e.kind))
        .map((e) => e.id)
        .sort();
      return ids.length > 0 && ids.length <= 200 ? enumOf(ids) : str('an entity id');
    }
    case 'climate':
      return obj({ temperature: range, moisture: range });
    case 'steps':
      return arr(obj({ text: str(), needs: arr(str('an entity id')) }));
    case 'boolean':
      return bool();
  }
}

/** The kind candidates take for a request: `null` for findings; the target's kind for about-moves. */
export function expectedKind(
  world: World,
  req: Pick<SpreadReq, 'spot' | 'move'>,
): EntityKind | null {
  const out = MOVE_DEFS[req.move].output;
  if (out === 'finding') return null;
  return spotKind(world, req.spot);
}

/** The structured-output schema of a spread: axes, then candidates with the kind's own fields. */
export function spreadOutputSchema(world: World, req: SpreadReq): Json {
  const kind = expectedKind(world, req);
  const schema = schemaOf(world);
  const fields = kind
    ? obj(
        Object.fromEntries(
          schema.kinds[kind].fields
            .filter((f) => f.ai !== false && !(kind === 'biome' && f.key === 'band'))
            .map((f) => [f.key, nullable(fieldJson(world, f))]),
        ),
      )
    : obj({});
  const axis = obj({ label: str(), low: str(), high: str() });
  const about = MOVE_DEFS[req.move].output === 'about';
  const candidate = obj({
    kind: kind ? enumOf([kind]) : { type: 'null' },
    name: str(),
    identity: str('one sentence, at most 20 words'),
    description: str(),
    fields,
    attributes: arr(obj({ key: str(), value: num() })),
    relations: arr(
      obj({ type: enumOf(Object.keys(schema.relations).sort()), target: str(), note: str() }),
    ),
    about: about ? enumOf(spotEntities(world, req.spot)) : { type: 'null' },
    position: obj({ x: num('0..1'), y: num('0..1') }),
    wildcard: bool(),
    rationale: str('at most 15 words'),
  });
  return obj({ axes: obj({ x: axis, y: axis }), candidates: arr(candidate) });
}

// ── Parsing ─────────────────────────────────────────────────────────────────

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const text = (v: unknown, max = 600): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
const unit = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
export const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * One raw candidate from the model, validated against the world and the
 * request: the kind it must have, a name that isn't taken, only fields that
 * parse, only relations the rules allow, `about` one of the spot's entities.
 * `null` drops it (and the gateway counts it). Key: `c<index + 1>`, so a
 * streamed card and the final result agree.
 */
export function parseSpreadCandidate(
  world: World,
  req: SpreadReq,
  raw: unknown,
  index: number,
): Candidate | null {
  const x = record(raw);
  // Only the first `count` items count, streamed or not, so the two always agree.
  if (!x || index >= req.count) return null;
  const def = MOVE_DEFS[req.move];
  const expected = expectedKind(world, req);
  const name = text(x.name, 80);
  if (name === '') return null;
  let about: EntityId | undefined;
  if (def.output === 'about') {
    const ents = spotEntities(world, req.spot);
    about =
      typeof x.about === 'string' && ents.includes(x.about)
        ? x.about
        : ents.length === 1
          ? ents[0]
          : undefined;
    if (!about) return null;
  }
  const target = about ? getEntity(world, about) : undefined;
  let kind: EntityKind | null = expected;
  if (target) kind = target.kind;
  else if (
    expected !== null &&
    typeof x.kind === 'string' &&
    (ENTITY_KINDS as readonly string[]).includes(x.kind)
  ) {
    // Places fix the kind; an entity or selection spot may get siblings of another kind.
    const k = x.kind as EntityKind;
    if (k !== expected && (req.spot.type === 'cell' || req.spot.type === 'region')) return null;
    kind = k;
  }
  // A new entity may not take an existing name (a rename may not either).
  if (
    def.output !== 'finding' &&
    Object.values(world.entities).some((e) => e.id !== about && normName(e.name) === normName(name))
  )
    return null;
  const rawRelations = (Array.isArray(x.relations) ? x.relations : []).flatMap((r) => {
    const rr = record(r);
    if (!rr || typeof rr.type !== 'string' || typeof rr.target !== 'string') return [];
    const note = text(rr.note, 200);
    return [{ type: rr.type, target: rr.target, ...(note ? { note } : {}) }];
  });
  const relations =
    kind === null
      ? rawRelations.filter((r) => getEntity(world, r.target) && schemaOf(world).relations[r.type])
      : cleanRelations(world, kind, rawRelations, about);
  const rawAttrs: Record<string, number> = {};
  if (Array.isArray(x.attributes))
    for (const a of x.attributes) {
      const ar = record(a);
      if (ar && typeof ar.key === 'string' && typeof ar.value === 'number')
        rawAttrs[ar.key] = ar.value;
    }
  else if (record(x.attributes))
    for (const [k, v] of Object.entries(record(x.attributes) ?? {}))
      if (typeof v === 'number') rawAttrs[k] = v;
  const pos = record(x.position) ?? {};
  const description = text(x.description, 2000);
  const rationale = text(x.rationale, 300);
  return {
    key: `c${index + 1}`,
    kind,
    name,
    identity: text(x.identity, 300),
    ...(description ? { description } : {}),
    fields: kind ? cleanFields(world, kind, record(x.fields) ?? {}) : {},
    attributes: kind ? cleanAttributes(world, kind, rawAttrs) : {},
    relations,
    ...(about ? { about } : {}),
    position: { x: unit(pos.x), y: unit(pos.y) },
    wildcard: x.wildcard === true,
    ...(rationale ? { rationale } : {}),
  };
}

/**
 * The whole spread output: axes (the requested ones win), candidates parsed
 * one by one (only the first `count` items), names unique within the spread,
 * and exactly one wildcard (the first marked, else the last).
 */
export function parseSpreadOutput(
  world: World,
  req: SpreadReq,
  raw: unknown,
): Result<{ result: MomentResult<'spread'>; dropped: number }> {
  const x = record(raw);
  const list = x && Array.isArray(x.candidates) ? x.candidates : null;
  if (!list) return err('invalid_output', 'no candidates');
  const axes = z.object({ x: AxisSchema, y: AxisSchema }).safeParse(x?.axes);
  let dropped = 0;
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  list.forEach((c, i) => {
    const p = parseSpreadCandidate(world, req, c, i);
    if (!p || seen.has(normName(p.name))) dropped++;
    else {
      seen.add(normName(p.name));
      candidates.push(p);
    }
  });
  const first = candidates.findIndex((c) => c.wildcard);
  candidates.forEach(
    (c, i) => (c.wildcard = first >= 0 ? i === first : i === candidates.length - 1),
  );
  return ok({
    result: { axes: req.axes ?? (axes.success ? axes.data : MOVE_DEFS[req.move].axes), candidates },
    dropped,
  });
}

/** The structured-output schema of a patterns run. */
export const PATTERNS_OUTPUT_SCHEMA: Json = obj({
  patterns: arr(
    obj({ text: str(), examples: arr(str()), strength: num('0..1'), updates: nullable(str()) }),
  ),
});

/** Patterns output: text and strength required; `updates` only if that pattern exists; at most 5. */
export function parsePatternsOutput(
  world: World,
  raw: unknown,
): Result<{ result: MomentResult<'patterns'>; dropped: number }> {
  const list = record(raw)?.patterns;
  if (!Array.isArray(list)) return err('invalid_output', 'no patterns');
  let dropped = 0;
  const patterns: MomentResult<'patterns'>['patterns'] = [];
  for (const p of list) {
    const x = record(p);
    const t = text(x?.text, 300);
    if (
      !x ||
      t === '' ||
      typeof x.strength !== 'number' ||
      !Number.isFinite(x.strength) ||
      patterns.length >= 5
    ) {
      dropped++;
      continue;
    }
    const updates =
      typeof x.updates === 'string' && world.taste.patterns.some((q) => q.id === x.updates)
        ? x.updates
        : undefined;
    const examples = Array.isArray(x.examples)
      ? [...new Set(x.examples.filter((e): e is string => typeof e === 'string'))].slice(0, 6)
      : [];
    patterns.push({
      text: t,
      examples,
      strength: Math.min(1, Math.max(0, x.strength)),
      ...(updates ? { updates } : {}),
    });
  }
  return ok({ result: PatternsResultSchema.parse({ patterns }), dropped });
}

// ── The builders ────────────────────────────────────────────────────────────

/** The packer focus for a spot. */
export function spotFocusOf(spot: Spot): FocusLike {
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

/** The ask of a spread when a packer renders the entities: the spot, kind, direction and the task. */
export function spreadAsk(world: World, req: SpreadReq, parent?: Candidate): string {
  return `${spreadFocus(world, req, parent, false)}\n\n${spreadTask(world, req)}`;
}

export const SPREAD_DEFAULTS = { effort: 'medium', maxTokens: 32_000, stream: true } as const;
export const PATTERNS_DEFAULTS = { effort: 'medium', maxTokens: 8_000, stream: false } as const;

/** W4-shaped builders for `spread` and `patterns`, given W4's `assemble`. */
export function createSpreadPromptBuilders<B, O>(assemble: (input: AssembleLike<O>) => B) {
  const spread = {
    moment: 'spread' as const,
    defaults: SPREAD_DEFAULTS,
    build(world: World, req: SpreadReq, options?: O): Result<B> {
      const r = SpreadRequestSchema.safeParse(req);
      if (!r.success) return err('bad_request', 'not a spread request');
      const check = checkSpot(world, r.data.spot, r.data.move);
      if (!check.ok)
        return err(
          check.error.code === 'spot.missing' || check.error.code === 'spot.band'
            ? 'not_found'
            : 'bad_request',
          check.error.message,
        );
      return ok(
        assemble({
          moment: 'spread',
          world,
          focus: spotFocusOf(r.data.spot),
          instructions: SPREAD_SYSTEM,
          ask: spreadAsk(world, r.data),
          schema: spreadOutputSchema(world, r.data),
          defaults: SPREAD_DEFAULTS,
          ...(options !== undefined ? { options } : {}),
          ...(r.data.spot.type === 'entity' ? { entity: r.data.spot.entity } : {}),
          pack: { taste: r.data.ruleIds ? { ruleIds: r.data.ruleIds } : {} },
        }),
      );
    },
    parse: (raw: unknown, world: World, req: SpreadReq) => parseSpreadOutput(world, req, raw),
    stream: {
      arrayKey: 'candidates',
      item: (raw: unknown, index: number, world: World, req: SpreadReq) =>
        parseSpreadCandidate(world, req, raw, index),
    },
  };
  const patterns = {
    moment: 'patterns' as const,
    defaults: PATTERNS_DEFAULTS,
    build(world: World, req: PatternsReq, options?: O): Result<B> {
      if (req.judgements.length === 0) return err('bad_request', 'no judgements');
      return ok(
        assemble({
          moment: 'patterns',
          world,
          focus: { entities: [] },
          instructions: PATTERNS_SYSTEM,
          ask: `${patternsFocus(world, req)}\n\n${PATTERNS_TASK}`,
          schema: PATTERNS_OUTPUT_SCHEMA,
          defaults: PATTERNS_DEFAULTS,
          ...(options !== undefined ? { options } : {}),
          pack: { budget: 20_000 },
        }),
      );
    },
    parse: (raw: unknown, world: World) => parsePatternsOutput(world, raw),
  };
  return [spread, patterns] as const;
}
