import type { Entity } from '../model/entity';
import { heightValue } from '../model/fields';
import type { EntityId } from '../model/ids';
import type { World } from '../model/world';
import { resolvePlacement } from '../placement';

/**
 * Where an entity sits on Y, as far as the AI context needs it: its band and
 * biome, from the placement resolver (`src/core/placement/`).
 */
export interface Place {
  band?: EntityId;
  biome?: EntityId;
  /** True when the resolver inferred the place (it isn't pinned). */
  inferred: boolean;
}

export type PlacementResolver = (world: World, entity: Entity) => Place;

/**
 * The resolver the AI uses: `resolvePlacement`. The band is the lowest band
 * the entity sits in; the biome is the entity itself for a biome, else the
 * first biome it is placed in.
 */
export const defaultPlacement: PlacementResolver = (world, entity) => {
  const p = resolvePlacement(world)[entity.id];
  const band = p?.bands[0];
  const biome = entity.kind === 'biome' ? entity.id : p?.biomes[0];
  return {
    ...(band ? { band } : {}),
    ...(biome ? { biome } : {}),
    inferred: p?.mode === 'inferred',
  };
};

/** A band's bottom as a number (−∞ for the endless depths), for ordering bands. */
export function bandBottom(band: Entity): number {
  const v = band.fields.y_bottom;
  if (typeof v === 'number' || v === '-inf' || v === '+inf') return heightValue(v);
  return 0;
}
