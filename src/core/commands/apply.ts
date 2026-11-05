import { z } from 'zod';
import type { Entity } from '../model/entity';
import { canonicalPatch } from '../files/canonical';
import { schemaProblems, type WorldSchema } from '../model/schema';
import { imagesProblems } from '../images/commands';
import { problemsOf, validateWorld, type Problem } from '../model/validate';
import { getEntity, schemaOf, WorldSchemaZ, type World } from '../model/world';
import { err, ok, type Result } from '../util/result';
import type { CommandContext } from './define';
import { applyWithInverse, PatchError, type Patch } from './patch';
import { commandDef, type Command } from './registry';

/** The wire shape of a command; `applyCommand` checks the payload per type. */
export const CommandSchema = z.object({ type: z.string(), payload: z.unknown() });

export interface Applied {
  world: World;
  /** The ops that were applied. */
  patch: Patch;
  /** Ops that undo them exactly. */
  inverse: Patch;
}

/** Warnings that are tolerated on load but that a command must never introduce. */
const STRICT_WARNINGS = new Set([
  'relation.dangling',
  'ref.dangling',
  'relation.asymmetric',
  'field.unknown',
]);

const problemKey = (p: Problem): string => `${p.entity}|${p.code}|${p.path.join('.')}|${p.message}`;
const errorKeys = (ps: Problem[]): Set<string> =>
  new Set(ps.filter((p) => p.severity === 'error').map(problemKey));

/**
 * Checks that a patch didn't make the world invalid: touched sections still
 * parse, and touched entities gained no new errors. (Pre-existing problems,
 * e.g. from an external edit, don't block unrelated commands.)
 */
export function checkPatched(before: World, after: World, patch: Patch): Problem[] {
  const sections = new Set(patch.map((op) => op.path[0]));
  const out: Problem[] = [];
  const sectionProblem = (section: string, message: string): Problem => ({
    severity: 'error',
    code: 'world.section',
    message: `${section}: ${message}`,
    entity: '',
    path: [section],
  });
  for (const s of sections) {
    if (s === 'entities' || s === undefined) continue;
    if (!(s in WorldSchemaZ.shape)) {
      out.push(sectionProblem(s, 'not a world section'));
      continue;
    }
    const r = WorldSchemaZ.shape[s as keyof typeof WorldSchemaZ.shape].safeParse(
      after[s as keyof World],
    );
    if (!r.success) out.push(sectionProblem(s, r.error.issues[0]?.message ?? 'invalid'));
    // Added by images-core: images keep their canonical form (core/images/commands.ts).
    else if (s === 'images')
      for (const m of imagesProblems(after.images)) out.push(sectionProblem(s, m));
  }
  if (out.length > 0) return out;
  if (sections.has('schema')) {
    for (const m of schemaProblems(schemaOf(after))) out.push(sectionProblem('schema', m));
    if (out.length > 0) return out;
    // A schema change can invalidate any entity: compare whole-world errors.
    const was = errorKeys(validateWorld(before));
    return validateWorld(after).filter((p) => p.severity === 'error' && !was.has(problemKey(p)));
  }
  const touched = new Set(
    patch.filter((op) => op.path[0] === 'entities' && op.path[1]).map((op) => op.path[1] as string),
  );
  // A new id may resolve references that were dangling (e.g. after an external
  // edit): re-check whatever points at it. Only an id something already
  // pointed at can be one, so the scan runs only for those (a transaction of
  // thousands of creates would otherwise scan every entity for each).
  const missing = missingTargets(before);
  noteMissing(after, missing, touched);
  for (const id of [...touched]) {
    if (getEntity(before, id) || !getEntity(after, id) || !missing.has(id)) continue;
    for (const other of Object.values(after.entities))
      if (other.relations.some((r) => r.target === id) || Object.values(other.fields).includes(id))
        touched.add(other.id);
  }
  for (const id of touched) {
    const now = getEntity(after, id);
    if (!now) continue;
    if (now.id !== id) {
      out.push({
        severity: 'error',
        code: 'entity.key',
        message: `stored under "${id}" but its id is "${now.id}"`,
        entity: id,
        path: ['id'],
      });
      continue;
    }
    const prev = getEntity(before, id);
    const was = prev ? new Set(problemsOf(before, prev).map(problemKey)) : new Set<string>();
    for (const p of problemsOf(after, now)) {
      // Commands may not *introduce* dangling or one-sided references either.
      const blocking = p.severity === 'error' || STRICT_WARNINGS.has(p.code);
      if (blocking && !was.has(problemKey(p))) out.push({ ...p, severity: 'error' });
    }
  }
  return out;
}

/** The ids an entity's relations and `ref` fields point at (what `referenceProblems` resolves). */
function targetsOf(schema: WorldSchema, e: Entity): string[] {
  const out = e.relations.map((r) => r.target);
  for (const f of schema.kinds[e.kind].fields) {
    const v = e.fields[f.key];
    if (f.type === 'ref' && typeof v === 'string') out.push(v);
  }
  return out;
}

/**
 * Per entities object (and schema), a superset of the ids its entities point
 * at that don't exist: the only ids whose creation can change another
 * entity's problems. Kept from world to world as commands apply, so it costs
 * O(touched) per command instead of O(entities).
 */
const missingCache = new WeakMap<
  World['entities'],
  { schema: WorldSchema; ids: ReadonlySet<string> }
>();

function missingTargets(world: World): ReadonlySet<string> {
  const schema = schemaOf(world);
  const hit = missingCache.get(world.entities);
  if (hit?.schema === schema) return hit.ids;
  const ids = new Set<string>();
  for (const e of Object.values(world.entities))
    for (const t of targetsOf(schema, e)) if (!getEntity(world, t)) ids.add(t);
  missingCache.set(world.entities, { schema, ids });
  return ids;
}

/** Derives the set for `after` from `before`'s: the old ids, plus what touched entities now miss. */
function noteMissing(after: World, before: ReadonlySet<string>, touched: Iterable<string>): void {
  const schema = schemaOf(after);
  let ids = before;
  for (const id of touched) {
    const e = getEntity(after, id);
    if (!e) continue;
    for (const t of targetsOf(schema, e))
      if (!getEntity(after, t) && !ids.has(t)) {
        if (ids === before) ids = new Set(before);
        (ids as Set<string>).add(t);
      }
  }
  missingCache.set(after.entities, { schema, ids });
}

/** Applies a patch and checks the result. The building block for commands, undo and redo. */
export function applyChecked(world: World, given: Patch): Result<Applied> {
  // Values in the form the files give back, so a save and a reopen change nothing.
  const patch = canonicalPatch(given);
  let applied: { doc: World; inverse: Patch };
  try {
    applied = applyWithInverse(world, patch);
  } catch (e) {
    if (e instanceof PatchError) return err('patch.invalid', e.message, { path: e.path });
    throw e;
  }
  const problems = checkPatched(world, applied.doc, patch);
  if (problems.length > 0)
    return err('world.invalid', problems.map((p) => p.message).join('; '), { problems });
  return ok({ world: applied.doc, patch, inverse: applied.inverse });
}

/** Applies one command: validate payload → plan → apply → check. Pure. */
export function applyCommand(
  world: World,
  command: Command | { type: string; payload: unknown },
  ctx: CommandContext,
): Result<Applied> {
  const def = commandDef(command.type);
  if (!def) return err('command.unknown', `unknown command "${command.type}"`);
  const payload = def.payload.safeParse(command.payload);
  if (!payload.success)
    return err(
      'command.payload',
      `${command.type}: ${payload.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      {
        issues: payload.error.issues,
      },
    );
  const planned = def.plan(world, payload.data, ctx);
  if (!planned.ok) return planned;
  return applyChecked(world, planned.value);
}

/**
 * Applies several commands as one step (a transaction): all or nothing, with one
 * combined patch and one combined inverse.
 */
export function applyCommands(
  world: World,
  commands: readonly (Command | { type: string; payload: unknown })[],
  ctx: CommandContext,
): Result<Applied> {
  let cur = world;
  const patch: Patch = [];
  const inverses: Patch[] = [];
  for (const [i, c] of commands.entries()) {
    const r = applyCommand(cur, c, ctx);
    if (!r.ok)
      return {
        ok: false,
        error: { ...r.error, detail: { index: i, type: c.type, cause: r.error.detail } },
      };
    cur = r.value.world;
    patch.push(...r.value.patch);
    inverses.push(r.value.inverse);
  }
  return ok({ world: cur, patch, inverse: inverses.reverse().flat() });
}

/** The undo label for a list of commands. */
export function labelOf(
  world: World,
  commands: readonly (Command | { type: string; payload: unknown })[],
): string {
  const first = commands[0];
  if (!first) return 'Nothing';
  const def = commandDef(first.type);
  const parsed = def?.payload.safeParse(first.payload);
  const base = def && parsed?.success ? def.label(parsed.data, world) : first.type;
  return commands.length > 1 ? `${base} (+${commands.length - 1})` : base;
}
