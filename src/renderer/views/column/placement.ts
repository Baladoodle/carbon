import type { Entity } from '@core/model/entity';
import { getEntity, type World } from '@core/model/world';

/**
 * Where an entity sits on the Column: the band (and biome, when there is one)
 * of each of its places, and whether that is explicit or inferred.
 *
 * THIS IS A LOCAL FALLBACK. Placement belongs to package W2
 * (`src/core/placement/`, `resolvePlacement`). Until it's merged the Column
 * uses this adapter; at integration `placementOf` is swapped to call W2's
 * resolver and map its result to `Placement`. Nothing else in the Column or
 * the Bench reads relations to place entities.
 *
 * The rules here, deterministic and in order:
 *  1. A band is its own place.
 *  2. Explicit: a biome's `band` field; else `in_biome` relations (the biome's
 *     band); else `in_band` relations. Not inferred.
 *  3. Inferred, one or two hops: `found_in` / `lives_in` (biome or band), then
 *     the places of the entities a route's steps need, of `made_from`,
 *     `requires` and `unlocks` targets (and of whoever `unlocks` this entity).
 *     Marked inferred, with the entity it came through.
 *  4. Nothing: the Inbox.
 */
export interface Place {
  band: string;
  biome?: string;
}

export interface Placement {
  places: Place[];
  /** True when no explicit band or biome placed it. */
  inferred: boolean;
  /** For inferred placements: the entity the place came through (for the tooltip). */
  via?: string;
}

export const INBOX: Placement = { places: [], inferred: false };

const placeKey = (p: Place): string => `${p.band}/${p.biome ?? ''}`;

function dedupe(places: Place[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const p of places) {
    const k = placeKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** The place a band or biome target stands for. */
function placeOfTarget(world: World, id: string): Place | null {
  const t = getEntity(world, id);
  if (!t) return null;
  if (t.kind === 'band') return { band: t.id };
  if (t.kind === 'biome') {
    const band = t.fields.band;
    if (typeof band === 'string' && getEntity(world, band)?.kind === 'band')
      return { band, biome: t.id };
  }
  return null;
}

function explicitPlaces(world: World, e: Entity): Place[] {
  if (e.kind === 'band') return [{ band: e.id }];
  if (e.kind === 'biome') {
    const p = placeOfTarget(world, e.id);
    if (p) return [p];
  }
  const viaBiome = e.relations
    .filter((r) => r.type === 'in_biome')
    .map((r) => placeOfTarget(world, r.target))
    .filter((p): p is Place => p !== null);
  if (viaBiome.length > 0) return dedupe(viaBiome);
  return dedupe(
    e.relations
      .filter((r) => r.type === 'in_band')
      .map((r) => placeOfTarget(world, r.target))
      .filter((p): p is Place => p !== null && p.biome === undefined),
  );
}

/** Ids an entity's inferred place can come through, in priority order. */
interface Ctx {
  world: World;
  /** target id → ids of the feats that unlock it. */
  unlockedBy: Map<string, string[]>;
}

function contextOf(world: World): Ctx {
  const unlockedBy = new Map<string, string[]>();
  for (const other of Object.values(world.entities))
    for (const r of other.relations)
      if (r.type === 'unlocks')
        unlockedBy.set(r.target, [...(unlockedBy.get(r.target) ?? []), other.id]);
  return { world, unlockedBy };
}

function inferenceSources(ctx: Ctx, e: Entity): { direct: Place[]; through: string[] } {
  const { world } = ctx;
  const direct = e.relations
    .filter((r) => r.type === 'found_in' || r.type === 'lives_in')
    .map((r) => placeOfTarget(world, r.target))
    .filter((p): p is Place => p !== null);
  const through: string[] = [];
  const route = e.fields.route;
  if (Array.isArray(route))
    for (const step of route as { needs?: unknown }[])
      if (Array.isArray(step.needs))
        for (const n of step.needs) if (typeof n === 'string') through.push(n);
  for (const r of e.relations)
    if (r.type === 'made_from' || r.type === 'requires' || r.type === 'unlocks')
      through.push(r.target);
  // A capability or item is where the feat that unlocks it is.
  through.push(...(ctx.unlockedBy.get(e.id) ?? []));
  return { direct: dedupe(direct), through: [...new Set(through)].filter((id) => id !== e.id) };
}

function resolve(ctx: Ctx, e: Entity, depth: number, seen: Set<string>): Placement {
  const { world } = ctx;
  const explicit = explicitPlaces(world, e);
  if (explicit.length > 0) return { places: explicit, inferred: false };
  if (depth <= 0) return INBOX;
  const { direct, through } = inferenceSources(ctx, e);
  if (direct.length > 0) return { places: direct, inferred: true };
  for (const id of through) {
    if (seen.has(id)) continue;
    const t = getEntity(world, id);
    if (!t) continue;
    const p = resolve(ctx, t, depth - 1, new Set([...seen, id]));
    if (p.places.length > 0) return { places: p.places, inferred: true, via: id };
  }
  return INBOX;
}

/** The placement of one entity. Deterministic: same world, same answer. */
export function placementOf(world: World, entityId: string): Placement {
  const e = getEntity(world, entityId);
  if (!e) return INBOX;
  return resolve(contextOf(world), e, 2, new Set([e.id]));
}

/** Placements of every entity, keyed by id (one pass for the Column). */
export function placementsOf(world: World): Map<string, Placement> {
  const ctx = contextOf(world);
  const out = new Map<string, Placement>();
  for (const e of Object.values(world.entities)) out.set(e.id, resolve(ctx, e, 2, new Set([e.id])));
  return out;
}
