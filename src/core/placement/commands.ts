import { z } from 'zod';
import { defineCommand } from '../commands/define';
import type { Patch } from '../commands/patch';
import type { Relation } from '../model/entity';
import { EntityIdSchema } from '../model/ids';
import type { KindSet } from '../model/schema';
import { getEntity, schemaOf, type World } from '../model/world';
import { err, ok, type Result } from '../util/result';
import { PIN_RELATIONS, resolvePlacement } from './resolve';

const allows = (set: KindSet, kind: string): boolean => set === '*' || set.includes(kind as never);
const isPin = (r: Relation): boolean => (PIN_RELATIONS as readonly string[]).includes(r.type);

/**
 * The relations that pin `id` to `to` (bands and biomes). Pure; shared by the
 * command and by callers that want to preview a pin.
 */
export function pinRelations(world: World, id: string, to: readonly string[]): Result<Relation[]> {
  const e = getEntity(world, id);
  if (!e) return err('entity.not_found', `no entity "${id}"`, { id });
  if (e.kind === 'band' || e.kind === 'biome')
    return err(
      'placement.own_field',
      e.kind === 'band'
        ? `${e.name} is placed by its own edges`
        : `${e.name} is placed by its band field`,
      { id },
    );
  const rels = schemaOf(world).relations;
  const out: Relation[] = [];
  for (const t of [...new Set(to)]) {
    const target = getEntity(world, t);
    if (!target) return err('entity.not_found', `no entity "${t}"`, { id: t });
    const type = target.kind === 'band' ? 'in_band' : target.kind === 'biome' ? 'in_biome' : null;
    if (!type)
      return err('placement.target', `${target.name} is a ${target.kind}, not a band or biome`, {
        id: t,
      });
    const def = rels[type];
    if (!def || !allows(def.from, e.kind) || !allows(def.to, target.kind))
      return err('placement.not_allowed', `a ${e.kind} can't be ${type.replace('_', ' ')}`, {
        type,
      });
    out.push({ type, target: t });
  }
  return ok(out);
}

/**
 * `placement.pin { id, to? }` replaces an entity's `in_band` / `in_biome`
 * relations with pins to `to` (bands and biomes). Without `to`, it pins the
 * entity where it is inferred to be now: its biomes, plus any of its bands that
 * none of those biomes covers, so the pinned bands equal the inferred ones.
 */
export const pinPlacement = defineCommand({
  payload: z.object({ id: EntityIdSchema, to: z.array(EntityIdSchema).min(1).optional() }),
  label: (p, w) => `Pin ${getEntity(w, p.id)?.name ?? p.id}`,
  plan(world, p, ctx) {
    const e = getEntity(world, p.id);
    if (!e) return err('entity.not_found', `no entity "${p.id}"`, { id: p.id });
    let to = p.to;
    if (!to && e.kind !== 'band' && e.kind !== 'biome') {
      const now = resolvePlacement(world)[p.id];
      if (!now || now.mode === 'unplaced')
        return err('placement.unplaced', `${e.name} has no place to pin`, { id: p.id });
      if (now.mode === 'pinned')
        return err('placement.pinned', `${e.name} is already pinned`, { id: p.id });
      // Its biomes, plus any band none of those biomes covers, so the pin keeps every band.
      const all = resolvePlacement(world);
      const covered = new Set(now.biomes.flatMap((b) => all[b]?.bands ?? []));
      to = [...now.biomes, ...now.bands.filter((b) => !covered.has(b))];
    }
    const pins = pinRelations(world, p.id, to ?? []);
    if (!pins.ok) return pins;
    const relations = [...e.relations.filter((r) => !isPin(r)), ...pins.value];
    const same =
      relations.length === e.relations.length &&
      relations.every((r) => e.relations.some((q) => q.type === r.type && q.target === r.target));
    if (same) return err('placement.same', `${e.name} is already pinned there`, { id: p.id });
    const patch: Patch = [
      { op: 'set', path: ['entities', p.id, 'relations'], value: relations },
      { op: 'set', path: ['entities', p.id, 'updated'], value: ctx.now },
    ];
    return ok(patch);
  },
});

/** `placement.unpin { id }` removes an entity's pins, so its place is inferred again. */
export const unpinPlacement = defineCommand({
  payload: z.object({ id: EntityIdSchema }),
  label: (p, w) => `Unpin ${getEntity(w, p.id)?.name ?? p.id}`,
  plan(world, p, ctx) {
    const e = getEntity(world, p.id);
    if (!e) return err('entity.not_found', `no entity "${p.id}"`, { id: p.id });
    if (e.kind === 'band' || e.kind === 'biome')
      return err('placement.own_field', `${e.name} is placed by its own fields`, { id: p.id });
    const relations = e.relations.filter((r) => !isPin(r));
    if (relations.length === e.relations.length)
      return err('placement.not_pinned', `${e.name} isn't pinned`, { id: p.id });
    return ok([
      { op: 'set', path: ['entities', p.id, 'relations'], value: relations },
      { op: 'set', path: ['entities', p.id, 'updated'], value: ctx.now },
    ]);
  },
});

export const placementCommands = {
  'placement.pin': pinPlacement,
  'placement.unpin': unpinPlacement,
} as const;
