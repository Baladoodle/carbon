import type { Entity } from '../model/entity';
import { heightValue } from '../model/fields';
import type { EntityId } from '../model/ids';
import { getEntity, type World } from '../model/world';

/**
 * Where an entity sits on Y, as far as the AI context needs it: its band and
 * biome. This is an ADAPTER. Package W2 builds the real resolver in
 * `src/core/placement/` (`resolvePlacement`); until it is merged, carbon's AI
 * uses only explicit placement (the entity itself, `biome.band`, and the
 * `in_band` / `in_biome` relations), plus `found_in` / `lives_in` targets,
 * marked inferred. Swapping in W2's resolver is a change to `defaultPlacement`
 * only.
 */
export interface Place {
  band?: EntityId;
  biome?: EntityId;
  /** True when the place comes from a relation that isn't `in_band` / `in_biome`. */
  inferred: boolean;
}

export type PlacementResolver = (world: World, entity: Entity) => Place;

const bandOfBiome = (world: World, biomeId: EntityId): EntityId | undefined => {
  const b = getEntity(world, biomeId);
  const band = b?.fields.band;
  return typeof band === 'string' && getEntity(world, band)?.kind === 'band' ? band : undefined;
};

export const explicitPlacement: PlacementResolver = (world, entity) => {
  if (entity.kind === 'band') return { band: entity.id, inferred: false };
  if (entity.kind === 'biome') {
    const band = bandOfBiome(world, entity.id);
    return band
      ? { band, biome: entity.id, inferred: false }
      : { biome: entity.id, inferred: false };
  }
  const target = (types: string[]): Entity | undefined => {
    for (const r of entity.relations) {
      if (!types.includes(r.type)) continue;
      const t = getEntity(world, r.target);
      if (t && (t.kind === 'band' || t.kind === 'biome')) return t;
    }
    return undefined;
  };
  const from = (t: Entity, inferred: boolean): Place =>
    t.kind === 'band'
      ? { band: t.id, inferred }
      : (() => {
          const band = bandOfBiome(world, t.id);
          return band ? { band, biome: t.id, inferred } : { biome: t.id, inferred };
        })();
  const biome = target(['in_biome']);
  if (biome) return from(biome, false);
  const band = target(['in_band']);
  if (band) return from(band, false);
  const lived = target(['found_in', 'lives_in']);
  if (lived) return from(lived, true);
  return { inferred: false };
};

/** The resolver the AI uses. Replace with W2's `resolvePlacement` once merged. */
export const defaultPlacement: PlacementResolver = explicitPlacement;

/** A band's bottom as a number (−∞ for the endless depths), for ordering bands. */
export function bandBottom(band: Entity): number {
  const v = band.fields.y_bottom;
  if (typeof v === 'number' || v === '-inf' || v === '+inf') return heightValue(v);
  return 0;
}
