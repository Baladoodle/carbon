import { z } from 'zod';
import {
  AttributesSchema,
  EntitySchema,
  KilledSchema,
  OriginSchema,
  RelationSchema,
  type Entity,
  type Relation,
} from '../model/entity';
import { EntityIdSchema, uniqueId } from '../model/ids';
import { EntityKindSchema, EntityStateSchema } from '../model/kinds';
import { canTransition, missingFor } from '../model/lifecycle';
import { isEditableCommonField } from '../model/schema';
import { getEntity, schemaOf, type World } from '../model/world';
import { err, ok, type Result } from '../util/result';
import { defineCommand } from './define';
import type { Patch } from './patch';

const ent = (id: string): string[] => ['entities', id];

function need(world: World, id: string): Result<Entity> {
  const e = getEntity(world, id);
  return e ? ok(e) : err('entity.not_found', `no entity "${id}"`, { id });
}

/** Relations to add on other entities so symmetric relations hold on both ends. */
function mirrorRelations(world: World, sourceId: string, relations: Relation[]): Patch {
  const schema = schemaOf(world);
  const byTarget = new Map<string, Relation[]>();
  for (const r of relations) {
    if (!schema.relations[r.type]?.symmetric) continue;
    const target = getEntity(world, r.target);
    if (!target) continue;
    const list = byTarget.get(r.target) ?? [...target.relations];
    if (!list.some((t) => t.type === r.type && t.target === sourceId))
      list.push({ type: r.type, target: sourceId, ...(r.note ? { note: r.note } : {}) });
    byTarget.set(r.target, list);
  }
  return [...byTarget].map(([id, list]) => ({
    op: 'set',
    path: [...ent(id), 'relations'],
    value: list,
  }));
}

export const createEntity = defineCommand({
  payload: z.object({
    kind: EntityKindSchema,
    name: z.string().min(1),
    /** Defaults to a unique slug of the name. */
    id: EntityIdSchema.optional(),
    identity: z.string().optional(),
    description: z.string().optional(),
    why: z.string().optional(),
    tags: z.array(z.string()).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    attributes: AttributesSchema.optional(),
    relations: z.array(RelationSchema).optional(),
    origin: OriginSchema.optional(),
    ai_fields: z.array(z.string()).optional(),
    agent_fields: z.array(z.string()).optional(),
  }),
  label: (p) => `Create ${p.name}`,
  plan(world, p, ctx) {
    if (p.id !== undefined && getEntity(world, p.id))
      return err('entity.exists', `an entity "${p.id}" already exists`, { id: p.id });
    const id = p.id ?? uniqueId(p.name, (c) => getEntity(world, c) !== undefined);
    const kindDef = schemaOf(world).kinds[p.kind];
    const fields: Record<string, unknown> = {};
    for (const f of kindDef.fields) if (f.default !== undefined) fields[f.key] = f.default;
    Object.assign(fields, p.fields ?? {});
    const attributes: Record<string, number> = {};
    for (const a of kindDef.attributes) if (a.default !== undefined) attributes[a.key] = a.default;
    Object.assign(attributes, p.attributes ?? {});
    const entity: Entity = EntitySchema.parse({
      id,
      kind: p.kind,
      name: p.name,
      identity: p.identity ?? '',
      description: p.description ?? '',
      state: 'idea',
      why: p.why ?? '',
      tags: p.tags ?? [],
      fields,
      attributes,
      relations: p.relations ?? [],
      origin: p.origin ?? { by: 'user' },
      ai_fields: p.ai_fields ?? [],
      ...(p.agent_fields && p.agent_fields.length > 0
        ? { agent_fields: [...new Set(p.agent_fields)] }
        : {}),
      created: ctx.now,
      updated: ctx.now,
    });
    return ok([
      { op: 'set', path: ent(id), value: entity },
      ...mirrorRelations(world, id, entity.relations),
    ]);
  },
});

/** A value for a field: `null` clears it. */
const FieldChanges = z.record(z.string(), z.unknown());

/**
 * Who wrote a value: `user` clears the markers, `ai` marks it AI-written
 * (`ai_fields`), `agent` marks it written by an outside agent (`agent_fields`,
 * docs/MCP.md). A key carries at most one of the two markers.
 */
export const SourceSchema = z.enum(['user', 'ai', 'agent']);
export type Source = z.infer<typeof SourceSchema>;

/** The patch ops that bring `ai_fields` and `agent_fields` to `ai` and `agent` (agent_fields absent when empty). */
function markerOps(e: Entity, ai: readonly string[], agent: readonly string[]): Patch {
  const ops: Patch = [];
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((k, i) => k === b[i]);
  if (!same(ai, e.ai_fields))
    ops.push({ op: 'set', path: ['entities', e.id, 'ai_fields'], value: [...ai] });
  const was = e.agent_fields ?? [];
  if (!same(agent, was)) {
    if (agent.length === 0) ops.push({ op: 'remove', path: ['entities', e.id, 'agent_fields'] });
    else ops.push({ op: 'set', path: ['entities', e.id, 'agent_fields'], value: [...agent] });
  }
  return ops;
}

/** Applies one key's marker for `source` to the two marker sets. */
function mark(key: string, source: Source, ai: Set<string>, agent: Set<string>): void {
  if (source === 'ai') ai.add(key);
  else ai.delete(key);
  if (source === 'agent') agent.add(key);
  else agent.delete(key);
}

function planFieldChanges(
  world: World,
  e: Entity,
  set: Record<string, unknown>,
  source: Source,
  now: string,
): Result<Patch> {
  const kind = schemaOf(world).kinds[e.kind];
  const patch: Patch = [];
  const fields = { ...e.fields };
  let fieldsChanged = false;
  const ai = new Set(e.ai_fields);
  const agent = new Set(e.agent_fields ?? []);
  for (const [key, raw] of Object.entries(set)) {
    const clear = raw === null || raw === undefined;
    if (isEditableCommonField(key)) {
      if (key === 'tags') {
        const v = clear ? [] : z.array(z.string()).safeParse(raw);
        if (!Array.isArray(v) && !v.success)
          return err('field.invalid', 'tags must be a list of strings', { key });
        patch.push({ op: 'set', path: [...ent(e.id), key], value: Array.isArray(v) ? v : v.data });
      } else {
        if (!clear && typeof raw !== 'string')
          return err('field.invalid', `${key} must be text`, { key });
        const value = clear ? '' : raw;
        if (key === 'name' && value.trim() === '')
          return err('field.invalid', 'an entity needs a name', { key });
        patch.push({ op: 'set', path: [...ent(e.id), key], value });
      }
    } else {
      if (!kind.fields.some((f) => f.key === key))
        return err('field.unknown', `"${key}" is not a field of ${kind.label}`, { key });
      if (clear) delete fields[key];
      else fields[key] = raw;
      fieldsChanged = true;
    }
    mark(key, source, ai, agent);
  }
  if (fieldsChanged) patch.push({ op: 'set', path: [...ent(e.id), 'fields'], value: fields });
  patch.push(...markerOps(e, [...ai], [...agent]));
  // Editing an exported entity sends it back to decided (docs/EXPERIENCE.md §8).
  if (e.state === 'exported')
    patch.push({ op: 'set', path: [...ent(e.id), 'state'], value: 'decided' });
  patch.push({ op: 'set', path: [...ent(e.id), 'updated'], value: now });
  return ok(patch);
}

export const updateEntity = defineCommand({
  payload: z.object({
    id: EntityIdSchema,
    /** Common text fields (`name`, `identity`, `description`, `why`, `tags`) or kind fields; `null` clears. */
    set: FieldChanges,
    /** `ai` marks the fields as AI-written (accepting a suggestion), `agent` as agent-written; `user` clears the markers. */
    source: SourceSchema.default('user'),
  }),
  label: (p, w) => `Edit ${getEntity(w, p.id)?.name ?? p.id}`,
  plan(world, p, ctx) {
    const e = need(world, p.id);
    if (!e.ok) return e;
    return planFieldChanges(world, e.value, p.set, p.source, ctx.now);
  },
});

export const setField = defineCommand({
  payload: z.object({
    id: EntityIdSchema,
    field: z.string(),
    value: z.unknown(),
    source: SourceSchema.default('user'),
  }),
  label: (p, w) => `Set ${p.field} of ${getEntity(w, p.id)?.name ?? p.id}`,
  plan(world, p, ctx) {
    const e = need(world, p.id);
    if (!e.ok) return e;
    return planFieldChanges(world, e.value, { [p.field]: p.value ?? null }, p.source, ctx.now);
  },
});

export const deleteEntity = defineCommand({
  payload: z.object({ id: EntityIdSchema }),
  label: (p, w) => `Delete ${getEntity(w, p.id)?.name ?? p.id}`,
  plan(world, p, ctx) {
    const e = need(world, p.id);
    if (!e.ok) return e;
    const patch: Patch = [{ op: 'remove', path: ent(p.id) }];
    const schema = schemaOf(world);
    // Cascade: drop relations pointing here and clear ref fields, so nothing dangles.
    for (const other of Object.values(world.entities)) {
      if (other.id === p.id) continue;
      const rels = other.relations.filter((r) => r.target !== p.id);
      const refKeys = schema.kinds[other.kind].fields
        .filter((f) => f.type === 'ref' && other.fields[f.key] === p.id)
        .map((f) => f.key);
      if (rels.length === other.relations.length && refKeys.length === 0) continue;
      if (rels.length !== other.relations.length)
        patch.push({ op: 'set', path: [...ent(other.id), 'relations'], value: rels });
      if (refKeys.length > 0) {
        const fields = { ...other.fields };
        for (const k of refKeys) delete fields[k];
        patch.push({ op: 'set', path: [...ent(other.id), 'fields'], value: fields });
      }
      patch.push({ op: 'set', path: [...ent(other.id), 'updated'], value: ctx.now });
    }
    return ok(patch);
  },
});

export const addRelation = defineCommand({
  payload: z.object({
    from: EntityIdSchema,
    type: z.string(),
    to: EntityIdSchema,
    note: z.string().optional(),
  }),
  label: (p, w) =>
    `Relate ${getEntity(w, p.from)?.name ?? p.from} → ${getEntity(w, p.to)?.name ?? p.to}`,
  plan(world, p, ctx) {
    const e = need(world, p.from);
    if (!e.ok) return e;
    const def = schemaOf(world).relations[p.type];
    if (!def)
      return err('relation.unknown_type', `unknown relation type "${p.type}"`, { type: p.type });
    const target = need(world, p.to);
    if (!target.ok) return target;
    if (e.value.relations.some((r) => r.type === p.type && r.target === p.to))
      return err('relation.exists', `${e.value.name} already ${def.label} ${target.value.name}`);
    const rel: Relation = { type: p.type, target: p.to, ...(p.note ? { note: p.note } : {}) };
    const patch: Patch = [
      { op: 'set', path: [...ent(p.from), 'relations'], value: [...e.value.relations, rel] },
      { op: 'set', path: [...ent(p.from), 'updated'], value: ctx.now },
    ];
    if (
      def.symmetric &&
      !target.value.relations.some((r) => r.type === p.type && r.target === p.from)
    ) {
      patch.push(
        {
          op: 'set',
          path: [...ent(p.to), 'relations'],
          value: [...target.value.relations, { ...rel, target: p.from }],
        },
        { op: 'set', path: [...ent(p.to), 'updated'], value: ctx.now },
      );
    }
    return ok(patch);
  },
});

export const removeRelation = defineCommand({
  payload: z.object({ from: EntityIdSchema, type: z.string(), to: EntityIdSchema }),
  label: (p, w) =>
    `Unrelate ${getEntity(w, p.from)?.name ?? p.from} → ${getEntity(w, p.to)?.name ?? p.to}`,
  plan(world, p, ctx) {
    const e = need(world, p.from);
    if (!e.ok) return e;
    const keep = (rs: Relation[], target: string): Relation[] =>
      rs.filter((r) => !(r.type === p.type && r.target === target));
    const rels = keep(e.value.relations, p.to);
    if (rels.length === e.value.relations.length)
      return err('relation.not_found', `${e.value.name} has no ${p.type} → ${p.to}`);
    const patch: Patch = [
      { op: 'set', path: [...ent(p.from), 'relations'], value: rels },
      { op: 'set', path: [...ent(p.from), 'updated'], value: ctx.now },
    ];
    const other = getEntity(world, p.to);
    if (schemaOf(world).relations[p.type]?.symmetric && other) {
      const back = keep(other.relations, p.from);
      if (back.length !== other.relations.length)
        patch.push(
          { op: 'set', path: [...ent(p.to), 'relations'], value: back },
          { op: 'set', path: [...ent(p.to), 'updated'], value: ctx.now },
        );
    }
    return ok(patch);
  },
});

export const setState = defineCommand({
  payload: z.object({
    id: EntityIdSchema,
    state: EntityStateSchema,
    /** Sets `why` in the same step (the Why gate when deciding). */
    why: z.string().optional(),
    /** Required when moving to the graveyard: the kill reason. */
    killed: KilledSchema.optional(),
  }),
  label: (p, w) => `Mark ${getEntity(w, p.id)?.name ?? p.id} ${p.state}`,
  plan(world, p, ctx) {
    const found = need(world, p.id);
    if (!found.ok) return found;
    const e = found.value;
    if (e.state === p.state) return err('state.same', `${e.name} is already ${p.state}`);
    if (!canTransition(e.state, p.state))
      return err('state.transition', `${e.name} can't go from ${e.state} to ${p.state}`, {
        from: e.state,
        to: p.state,
      });
    const next: Entity = { ...e, why: p.why ?? e.why, state: p.state };
    const missing = missingFor(schemaOf(world), next, p.state);
    if (missing.length > 0)
      return err('state.missing_fields', `${e.name} needs ${missing.join(', ')} to be ${p.state}`, {
        missing,
      });
    if (p.state === 'graveyard' && !p.killed)
      return err('state.kill_reason', 'moving to the graveyard needs a kill reason');
    const patch: Patch = [{ op: 'set', path: [...ent(e.id), 'state'], value: p.state }];
    if (p.why !== undefined) patch.push({ op: 'set', path: [...ent(e.id), 'why'], value: p.why });
    if (p.state === 'graveyard' && p.killed)
      patch.push({ op: 'set', path: [...ent(e.id), 'killed'], value: p.killed });
    if (e.state === 'graveyard') patch.push({ op: 'remove', path: [...ent(e.id), 'killed'] });
    patch.push({ op: 'set', path: [...ent(e.id), 'updated'], value: ctx.now });
    return ok(patch);
  },
});

export const setAttribute = defineCommand({
  payload: z.object({
    id: EntityIdSchema,
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** `null` removes the attribute. */
    value: z.number().refine(Number.isFinite, 'a finite number').nullable(),
    source: SourceSchema.default('user'),
  }),
  label: (p, w) => `Set ${p.key} of ${getEntity(w, p.id)?.name ?? p.id}`,
  plan(world, p, ctx) {
    const found = need(world, p.id);
    if (!found.ok) return found;
    const e = found.value;
    const attributes = { ...e.attributes };
    if (p.value === null) delete attributes[p.key];
    else attributes[p.key] = p.value;
    const marker = `attributes.${p.key}`;
    const ai = e.ai_fields.filter((k) => k !== marker);
    const agent = (e.agent_fields ?? []).filter((k) => k !== marker);
    if (p.source === 'ai' && p.value !== null) ai.push(marker);
    if (p.source === 'agent' && p.value !== null) agent.push(marker);
    const patch: Patch = [{ op: 'set', path: [...ent(e.id), 'attributes'], value: attributes }];
    patch.push(...markerOps(e, ai, agent));
    if (e.state === 'exported')
      patch.push({ op: 'set', path: [...ent(e.id), 'state'], value: 'decided' });
    patch.push({ op: 'set', path: [...ent(e.id), 'updated'], value: ctx.now });
    return ok(patch);
  },
});

export const entityCommands = {
  'entity.create': createEntity,
  'entity.update': updateEntity,
  'entity.setField': setField,
  'entity.delete': deleteEntity,
  'entity.setState': setState,
  'entity.setAttribute': setAttribute,
  'relation.add': addRelation,
  'relation.remove': removeRelation,
} as const;
