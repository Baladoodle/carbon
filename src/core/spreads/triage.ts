import type { Candidate, Spot } from '../ai/moments';
import { cmd, type Command } from '../commands/registry';
import type { Relation } from '../model/entity';
import { fieldValueSchema } from '../model/fields';
import { uniqueId, type EntityId } from '../model/ids';
import type { EntityKind } from '../model/kinds';
import { kindAllowed } from '../model/validate';
import { getEntity, schemaOf, type World } from '../model/world';
import { err, ok, type Result } from '../util/result';
import { MOVE_DEFS } from './moves';
import { candidateOf, type SpreadData } from './record';
import { spotBand, spotEntities, spotKind } from './spot';

/**
 * Triage (docs/EXPERIENCE.md §4): what each key does to the world, as a list
 * of commands sent as ONE transaction, so each key press is one undo step.
 * Candidates come from the AI, so everything is sanitised against the schema
 * here: fields that don't parse, relations the rules forbid and references to
 * entities that don't exist are left out rather than failing the keep.
 */

export interface Triage {
  label: string;
  commands: Command[];
  /** The entity the candidate became or changed, if any. */
  entity?: EntityId;
}

/** Fields of a candidate that are valid for `kind`, by the kind schema. */
export function cleanFields(
  world: World,
  kind: EntityKind,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const defs = schemaOf(world).kinds[kind].fields;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const def = defs.find((f) => f.key === key);
    if (!def || value === null || value === undefined) continue;
    const r = fieldValueSchema(def).safeParse(value);
    if (!r.success) continue;
    if (def.type === 'ref') {
      const t = getEntity(world, value as string);
      if (!t || (def.refKinds && !def.refKinds.includes(t.kind))) continue;
    }
    if (def.type === 'steps') {
      // Steps may name entities they need; keep only the ones that exist.
      out[key] = (r.data as { text: string; needs?: string[] }[]).map((s) => {
        const needs = (s.needs ?? []).filter((id) => getEntity(world, id));
        return needs.length > 0 ? { text: s.text, needs } : { text: s.text };
      });
      continue;
    }
    out[key] = r.data;
  }
  return out;
}

/** Attributes of a candidate that fit the kind's attribute definitions. */
export function cleanAttributes(
  world: World,
  kind: EntityKind,
  attributes: Record<string, number>,
): Record<string, number> {
  const defs = schemaOf(world).kinds[kind].attributes;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(attributes)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !Number.isFinite(v)) continue;
    const def = defs.find((a) => a.key === key);
    if (def && ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)))
      continue;
    out[key] = v;
  }
  return out;
}

/** Relations from `kind` (or from entity `selfId`) that the relation rules allow, unique. */
export function cleanRelations(
  world: World,
  kind: EntityKind,
  relations: readonly Relation[],
  selfId?: EntityId,
): Relation[] {
  const schema = schemaOf(world);
  const seen = new Set<string>();
  const out: Relation[] = [];
  for (const r of relations) {
    const def = schema.relations[r.type];
    const target = getEntity(world, r.target);
    if (!def || !target || r.target === selfId) continue;
    if (!kindAllowed(def.from, kind) || !kindAllowed(def.to, target.kind)) continue;
    const key = `${r.type}→${r.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      r.note
        ? { type: r.type, target: r.target, note: r.note }
        : { type: r.type, target: r.target },
    );
  }
  return out;
}

/** The entity an `about` candidate changes: its `about`, or the spot's only entity. */
export function targetOf(world: World, spread: SpreadData, c: Candidate): EntityId | undefined {
  if (c.about && getEntity(world, c.about)) return c.about;
  if (MOVE_DEFS[spread.move].output !== 'about') return undefined;
  const ents = spotEntities(world, spread.spot);
  return ents.length === 1 ? ents[0] : undefined;
}

/** What a candidate is: a finding, a change to an entity, or a new entity. */
export function candidateRole(
  world: World,
  spread: SpreadData,
  c: Candidate,
): 'finding' | 'about' | 'new' {
  if (c.kind === null) return 'finding';
  return targetOf(world, spread, c) ? 'about' : 'new';
}

/** Places a new entity at the spot: the band (field or relation) and the climate of a region. */
function placeAtSpot(
  world: World,
  spot: Spot,
  kind: EntityKind,
  fields: Record<string, unknown>,
  relations: Relation[],
): void {
  const band = spotBand(world, spot);
  if (kind === 'biome') {
    if (band && fields.band === undefined) fields.band = band;
    if (spot.type === 'region' && fields.climate === undefined) fields.climate = spot.climate;
    return;
  }
  if (!band || kind === 'band') return;
  if (relations.some((r) => r.type === 'in_band' || r.type === 'in_biome')) return;
  const def = schemaOf(world).relations.in_band;
  if (def && kindAllowed(def.from, kind)) relations.push({ type: 'in_band', target: band });
}

function newEntityCommand(
  world: World,
  spread: SpreadData,
  base: Candidate,
  extra: { description?: string; relations?: Relation[] } = {},
): { command: Command; id: EntityId } {
  const kind = base.kind ?? spotKind(world, spread.spot);
  const id = uniqueId(base.name, (x) => getEntity(world, x) !== undefined);
  const fields = cleanFields(world, kind, base.fields);
  const relations = cleanRelations(
    world,
    kind,
    [...base.relations, ...(extra.relations ?? [])],
    id,
  );
  placeAtSpot(world, spread.spot, kind, fields, relations);
  const description = extra.description ?? base.description ?? '';
  const aiFields = [
    'name',
    'identity',
    ...(description ? ['description'] : []),
    ...Object.keys(fields),
  ];
  return {
    id,
    command: cmd('entity.create', {
      kind,
      id,
      name: base.name.trim(),
      identity: base.identity,
      ...(description ? { description } : {}),
      fields,
      attributes: cleanAttributes(world, kind, base.attributes),
      relations,
      origin: { by: 'ai', moment: 'spread', spread: spread.id },
      ai_fields: [...new Set(aiFields)],
    }),
  };
}

const notJudged = (spread: SpreadData, key: string): Result<Candidate> => {
  const c = candidateOf(spread, key);
  if (!c) return err('spread.no_candidate', `no candidate "${key}"`);
  if (spread.judgements[key]) return err('spread.judged', `${c.name} is already judged`);
  return ok(c);
};

/** `k`: keep as an idea at the spot; for Ground, Cost and Name, apply the change to its entity. */
export function keepCommands(world: World, spread: SpreadData, key: string): Result<Triage> {
  const got = notJudged(spread, key);
  if (!got.ok) return got;
  const c = got.value;
  const role = candidateRole(world, spread, c);
  if (role === 'finding')
    return ok({
      label: `Keep ${c.name}`,
      commands: [cmd('spread.judge', { spread: spread.id, key, verdict: 'keep' })],
    });
  if (role === 'about') {
    const id = targetOf(world, spread, c) as EntityId;
    const target = getEntity(world, id);
    if (!target) return err('entity.not_found', `no entity "${id}"`);
    const set: Record<string, unknown> = cleanFields(world, target.kind, c.fields);
    delete set.band; // a biome's band is its place, never changed from a spread
    if (spread.move === 'name' && c.name.trim() !== '' && c.name.trim() !== target.name)
      set.name = c.name.trim();
    const commands: Command[] = [];
    if (Object.keys(set).length > 0) commands.push(cmd('entity.update', { id, set, source: 'ai' }));
    for (const r of cleanRelations(world, target.kind, c.relations, id))
      if (!target.relations.some((t) => t.type === r.type && t.target === r.target))
        commands.push(
          cmd('relation.add', {
            from: id,
            type: r.type,
            to: r.target,
            ...(r.note ? { note: r.note } : {}),
          }),
        );
    commands.push(cmd('spread.judge', { spread: spread.id, key, verdict: 'keep', entity: id }));
    return ok({ label: `Keep ${c.name}`, commands, entity: id });
  }
  const made = newEntityCommand(world, spread, c);
  return ok({
    label: `Keep ${c.name}`,
    entity: made.id,
    commands: [
      made.command,
      cmd('spread.judge', { spread: spread.id, key, verdict: 'keep', entity: made.id }),
    ],
  });
}

/** `x` then a reason key: kill, and count the reason. `note` is the typed words for "other". */
export function killCommands(
  world: World,
  spread: SpreadData,
  key: string,
  reasonKey: string,
  note?: string,
): Result<Triage> {
  const got = notJudged(spread, key);
  if (!got.ok) return got;
  const reason = world.taste.reasons.find((r) => r.key === reasonKey);
  if (!reason) return err('taste.no_reason', `no kill reason on ${reasonKey}`);
  const trimmed = note?.trim().slice(0, 200);
  return ok({
    label: `Kill ${got.value.name}`,
    commands: [
      cmd('spread.judge', {
        spread: spread.id,
        key,
        verdict: 'kill',
        reason: reason.key,
        reasonLabel: reason.label,
        ...(trimmed ? { note: trimmed } : {}),
      }),
      cmd('taste.countReason', { key: reason.key, by: 1 }),
    ],
  });
}

/**
 * `m`: merge the marked candidates into one new entity. They must be at least
 * two, unjudged, new entities of the same kind. The first marked gives the
 * name and identity; fields and attributes take the first value offered;
 * relations are the union. Each candidate is judged `merge` → the new entity.
 */
export function mergeCommands(
  world: World,
  spread: SpreadData,
  keys: readonly string[],
): Result<Triage> {
  const unique = [...new Set(keys)];
  if (unique.length < 2) return err('spread.merge_few', 'Mark two or more candidates to merge');
  const cands: Candidate[] = [];
  for (const k of unique) {
    const got = notJudged(spread, k);
    if (!got.ok) return got;
    if (candidateRole(world, spread, got.value) !== 'new')
      return err(
        'spread.merge_kind',
        `${got.value.name} changes an existing entity; keep it instead`,
      );
    cands.push(got.value);
  }
  const first = cands[0] as Candidate;
  if (cands.some((c) => c.kind !== first.kind))
    return err('spread.merge_kind', 'Only candidates of one kind can merge');
  const fields: Record<string, unknown> = {};
  const attributes: Record<string, number> = {};
  for (const c of cands) {
    for (const [k, v] of Object.entries(c.fields)) if (!(k in fields)) fields[k] = v;
    for (const [k, v] of Object.entries(c.attributes)) if (!(k in attributes)) attributes[k] = v;
  }
  const description = [
    ...(first.description ? [first.description, ''] : []),
    ...cands.map((c) => `- ${c.name}: ${c.identity}`),
  ].join('\n');
  const merged: Candidate = {
    ...first,
    fields,
    attributes,
    relations: cands.flatMap((c) => c.relations),
  };
  const made = newEntityCommand(world, spread, merged, { description });
  return ok({
    label: `Merge ${cands.length} candidates`,
    entity: made.id,
    commands: [
      made.command,
      ...unique.map((k) =>
        cmd('spread.judge', { spread: spread.id, key: k, verdict: 'merge', entity: made.id }),
      ),
    ],
  });
}

/**
 * `→`: the spot a follow-up spread aims at. A kept candidate is its entity; a
 * finding becomes a note spot naming the entities involved. A new candidate
 * not yet kept gives `null`: keep it first (the view does both in a row).
 */
export function followSpot(world: World, spread: SpreadData, key: string): Spot | null {
  const c = candidateOf(spread, key);
  if (!c) return null;
  const judged = spread.judgements[key]?.entity;
  if (judged && getEntity(world, judged)) return { type: 'entity', entity: judged };
  const role = candidateRole(world, spread, c);
  if (role === 'about') return { type: 'entity', entity: targetOf(world, spread, c) as EntityId };
  if (role === 'finding') {
    const involved = [
      ...new Set([
        ...c.relations.map((r) => r.target),
        ...(c.about ? [c.about] : []),
        ...spotEntities(world, spread.spot),
      ]),
    ].filter((id) => getEntity(world, id));
    return { type: 'note', note: `${c.name}: ${c.identity}`.slice(0, 500), entities: involved };
  }
  return null;
}
