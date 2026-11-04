import type { Entity } from '../model/entity';
import type { EntityId } from '../model/ids';
import { LANE_OF_KIND, type EntityKind, type Lane } from '../model/kinds';
import { getEntity, type World } from '../model/world';
import { defaultPlacement, type PlacementResolver } from './placement';

/**
 * What a request is about: the entities in focus (the entity being edited, a
 * selection) and/or a place (a Column cell: band + lane, or a band alone).
 */
export interface Focus {
  entities: readonly EntityId[];
  band?: EntityId;
  lane?: Lane;
  kind?: EntityKind;
}

/**
 * Relevance tiers, in SYSTEM §8 step 3's order. Lower is more relevant.
 *  0 direct relation (either direction, including ref fields and route needs)
 *  1 the same cell (same band and same lane)
 *  2 the same band
 *  3 the same kind
 *  4 everything else
 */
export type Tier = 0 | 1 | 2 | 3 | 4;

export interface Ranked {
  entity: Entity;
  tier: Tier;
}

/** Every entity id an entity points at: relations, ref fields and route `needs`. */
export function referencesOf(e: Entity): Set<EntityId> {
  const out = new Set<EntityId>();
  for (const r of e.relations) out.add(r.target);
  for (const v of Object.values(e.fields)) {
    if (!Array.isArray(v)) continue;
    for (const step of v as unknown[]) {
      const needs: unknown =
        step && typeof step === 'object' ? (step as { needs?: unknown }).needs : undefined;
      if (Array.isArray(needs))
        for (const n of needs as unknown[]) if (typeof n === 'string') out.add(n);
    }
  }
  const band = e.fields.band;
  if (e.kind === 'biome' && typeof band === 'string') out.add(band);
  return out;
}

/**
 * Ranks every entity not in focus by relevance: tier first, then recency
 * (`updated`, newest first), then id. A pure total order, so the same world and
 * focus always give the same ranking.
 */
export function rankEntities(
  world: World,
  focus: Focus,
  place: PlacementResolver = defaultPlacement,
): Ranked[] {
  const focusSet = new Set(focus.entities);
  const focused = focus.entities
    .map((id) => getEntity(world, id))
    .filter((e): e is Entity => e !== undefined);
  const direct = new Set<EntityId>();
  for (const f of focused) for (const id of referencesOf(f)) direct.add(id);

  const bands = new Set<EntityId>();
  const cells = new Set<string>();
  const kinds = new Set<EntityKind>();
  if (focus.band) bands.add(focus.band);
  if (focus.kind) kinds.add(focus.kind);
  if (focus.band && focus.lane) cells.add(`${focus.band}|${focus.lane}`);
  for (const f of focused) {
    kinds.add(f.kind);
    const p = place(world, f);
    if (p.band) {
      bands.add(p.band);
      const lane = LANE_OF_KIND[f.kind];
      if (lane) cells.add(`${p.band}|${lane}`);
    }
  }
  if (focus.lane && !focus.kind)
    for (const [k, l] of Object.entries(LANE_OF_KIND))
      if (l === focus.lane) kinds.add(k as EntityKind);

  const ranked: Ranked[] = [];
  for (const e of Object.values(world.entities)) {
    if (focusSet.has(e.id)) continue;
    let tier: Tier = 4;
    const refsFocus = [...referencesOf(e)].some((id) => focusSet.has(id));
    if (direct.has(e.id) || refsFocus) tier = 0;
    else {
      const p = place(world, e);
      const lane = LANE_OF_KIND[e.kind];
      const inBand = (p.band && bands.has(p.band)) || (e.kind === 'band' && bands.has(e.id));
      if (p.band && lane && cells.has(`${p.band}|${lane}`)) tier = 1;
      else if (inBand) tier = 2;
      else if (kinds.has(e.kind)) tier = 3;
    }
    ranked.push({ entity: e, tier });
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.entity.updated < b.entity.updated ? 1 : a.entity.updated > b.entity.updated ? -1 : 0) ||
      a.entity.id.localeCompare(b.entity.id),
  );
  return ranked;
}
