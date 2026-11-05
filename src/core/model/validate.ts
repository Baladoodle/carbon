import { EntitySchema, type Entity } from './entity';
import { fieldValueSchema, heightValue, HeightSchema, type Height } from './fields';
import { getEntity, schemaOf, type World } from './world';
import type { KindSet, RelationTypeDef, WorldSchema } from './schema';
import type { EntityKind } from './kinds';

/**
 * A problem with an entity. `error`s make a world invalid (commands refuse to
 * create them; the store quarantines files with them). `warn`s are kept and
 * surfaced (e.g. a dangling relation after an external edit).
 */
export interface Problem {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  entity: string;
  /** Path inside the entity, e.g. `["fields","climate"]` or `["relations","2"]`. */
  path: string[];
}

export const kindAllowed = (set: KindSet, kind: EntityKind): boolean =>
  set === '*' || set.includes(kind);

/** A band whose bottom edge isn't strictly below its top edge (both set). */
export const BAND_INVERTED = 'band.inverted';

/**
 * Errors that a file on disk may carry and still load. Commands refuse to
 * introduce them like any error, but on load (and on an outside edit) the
 * entity is kept, not quarantined: it is the user's file, and quarantining a
 * whole band over one swapped number would lose far more than it protects.
 * Readers treat such a band as edgeless (`bandRange`), and the mechanical
 * checks name it (`band-inverted`), so the user sees why it has no place.
 */
export const TOLERATED_ON_LOAD: ReadonlySet<string> = new Set([BAND_INVERTED]);

/** A height as the user reads it: a number, or ±∞. */
export const heightLabel = (h: Height): string =>
  typeof h === 'number' ? String(h) : h === '+inf' ? '+∞' : '−∞';

/**
 * The edge rule of a band: when both edges are set, the bottom lies strictly
 * below the top. A zero-height band covers no height, so it is inverted too
 * (placement already treats both the same: `bandRange` needs bottom < top).
 */
export function bandEdgeProblems(entity: Entity): Problem[] {
  if (entity.kind !== 'band') return [];
  const lo = HeightSchema.safeParse(entity.fields.y_bottom);
  const hi = HeightSchema.safeParse(entity.fields.y_top);
  if (!lo.success || !hi.success) return [];
  if (heightValue(lo.data) < heightValue(hi.data)) return [];
  return [
    {
      severity: 'error',
      code: BAND_INVERTED,
      message: `the bottom (${heightLabel(lo.data)}) must be below the top (${heightLabel(hi.data)})`,
      entity: entity.id,
      path: ['fields', 'y_bottom'],
    },
  ];
}

/**
 * Whether setting one field of an entity keeps its band edges in order (true
 * for every other field and kind). For proposals made outside a command, such
 * as AI suggestions, so a value carbon would refuse is never offered.
 */
export function edgesFit(entity: Entity, key: string, value: unknown): boolean {
  if (entity.kind !== 'band' || (key !== 'y_bottom' && key !== 'y_top')) return true;
  return bandEdgeProblems({ ...entity, fields: { ...entity.fields, [key]: value } }).length === 0;
}

/** Structural problems of one entity against the schema (no cross-entity checks). */
export function entityProblems(schema: WorldSchema, entity: Entity): Problem[] {
  const out: Problem[] = [];
  const base = EntitySchema.safeParse(entity);
  if (!base.success) {
    for (const issue of base.error.issues)
      out.push({
        severity: 'error',
        code: 'entity.shape',
        message: issue.message,
        entity: entity.id,
        path: issue.path.map(String),
      });
    return out;
  }
  const kind = schema.kinds[entity.kind];
  for (const [key, value] of Object.entries(entity.fields)) {
    const def = kind.fields.find((f) => f.key === key);
    if (!def) {
      out.push({
        severity: 'warn',
        code: 'field.unknown',
        message: `"${key}" is not a field of ${kind.label}`,
        entity: entity.id,
        path: ['fields', key],
      });
      continue;
    }
    const r = fieldValueSchema(def).safeParse(value);
    if (!r.success)
      out.push({
        severity: 'error',
        code: 'field.invalid',
        message: `${def.label}: ${r.error.issues[0]?.message ?? 'invalid value'}`,
        entity: entity.id,
        path: ['fields', key],
      });
  }
  for (const a of kind.attributes) {
    const v = entity.attributes[a.key];
    if (v === undefined) continue;
    if ((a.min !== undefined && v < a.min) || (a.max !== undefined && v > a.max))
      out.push({
        severity: 'error',
        code: 'attribute.range',
        message: `${a.label ?? a.key} must be within ${a.min ?? '-∞'}..${a.max ?? '∞'}`,
        entity: entity.id,
        path: ['attributes', a.key],
      });
  }
  // Only when the edges themselves are well-formed (a bad value is already reported).
  if (
    !out.some((p) => p.path[0] === 'fields' && (p.path[1] === 'y_bottom' || p.path[1] === 'y_top'))
  )
    out.push(...bandEdgeProblems(entity));
  return out;
}

/**
 * Cross-entity problems of one entity: its relations (type known, target exists,
 * kinds allowed, no self relation, no duplicates, symmetric counterpart) and its
 * `ref` fields. Cycles are checked separately (`cycleProblems`).
 */
export function referenceProblems(world: World, entity: Entity): Problem[] {
  const schema = schemaOf(world);
  const out: Problem[] = [];
  const p = (
    severity: Problem['severity'],
    code: string,
    message: string,
    path: string[],
  ): void => {
    out.push({ severity, code, message, entity: entity.id, path });
  };
  const seen = new Set<string>();
  entity.relations.forEach((r, i) => {
    const path = ['relations', String(i)];
    const def = schema.relations[r.type];
    if (!def) return p('error', 'relation.unknown_type', `unknown relation type "${r.type}"`, path);
    const key = `${r.type}→${r.target}`;
    if (seen.has(key)) p('error', 'relation.duplicate', `duplicate ${def.label} ${r.target}`, path);
    seen.add(key);
    if (r.target === entity.id)
      return p('error', 'relation.self', `an entity can't ${def.label} itself`, path);
    if (!kindAllowed(def.from, entity.kind))
      p(
        'error',
        'relation.source_kind',
        `a ${entity.kind} can't be the source of ${def.label}`,
        path,
      );
    const target = getEntity(world, r.target);
    if (!target)
      return p(
        'warn',
        'relation.dangling',
        `${def.label} → "${r.target}", which doesn't exist`,
        path,
      );
    if (!kindAllowed(def.to, target.kind))
      p('error', 'relation.target_kind', `${def.label} can't point to a ${target.kind}`, path);
    if (def.symmetric && !target.relations.some((t) => t.type === r.type && t.target === entity.id))
      p('warn', 'relation.asymmetric', `${def.label} ${r.target} is missing its other end`, path);
  });
  for (const f of schema.kinds[entity.kind].fields) {
    if (f.type !== 'ref') continue;
    const v = entity.fields[f.key];
    if (typeof v !== 'string') continue;
    const target = getEntity(world, v);
    if (!target)
      p('warn', 'ref.dangling', `${f.label} → "${v}", which doesn't exist`, ['fields', f.key]);
    else if (f.refKinds && !f.refKinds.includes(target.kind))
      p('error', 'ref.kind', `${f.label} can't point to a ${target.kind}`, ['fields', f.key]);
  }
  return out;
}

/** Entity ids on a cycle of an acyclic relation type that passes through `start`. */
export function findCycle(world: World, def: RelationTypeDef, start: string): string[] | null {
  const stack: string[] = [];
  const done = new Set<string>();
  const visit = (id: string): string[] | null => {
    const at = stack.indexOf(id);
    if (at >= 0) return stack.slice(at);
    if (done.has(id)) return null;
    stack.push(id);
    const e = getEntity(world, id);
    for (const r of e?.relations ?? []) {
      if (r.type !== def.type) continue;
      const c = visit(r.target);
      if (c) return c;
    }
    stack.pop();
    done.add(id);
    return null;
  };
  const cycle = visit(start);
  return cycle?.includes(start) ? cycle : null;
}

/** Cycle problems for an entity across every acyclic relation type. */
export function cycleProblems(world: World, entity: Entity): Problem[] {
  const out: Problem[] = [];
  for (const def of Object.values(schemaOf(world).relations)) {
    if (!def.acyclic) continue;
    const cycle = findCycle(world, def, entity.id);
    if (cycle)
      out.push({
        severity: 'error',
        code: 'relation.cycle',
        message: `${def.label} forms a cycle: ${[...cycle, cycle[0]].join(' → ')}`,
        entity: entity.id,
        path: ['relations'],
      });
  }
  return out;
}

/** Every problem of one entity in its world. */
export function problemsOf(world: World, entity: Entity): Problem[] {
  return [
    ...entityProblems(schemaOf(world), entity),
    ...referenceProblems(world, entity),
    ...cycleProblems(world, entity),
  ];
}

/** Every problem in a world, plus the entity-map key/id agreement. */
export function validateWorld(world: World): Problem[] {
  const out: Problem[] = [];
  for (const [key, e] of Object.entries(world.entities)) {
    if (key !== e.id)
      out.push({
        severity: 'error',
        code: 'entity.key',
        message: `stored under "${key}" but its id is "${e.id}"`,
        entity: e.id,
        path: ['id'],
      });
    out.push(...problemsOf(world, e));
  }
  return out;
}

export const errorsOnly = (ps: Problem[]): Problem[] => ps.filter((p) => p.severity === 'error');
