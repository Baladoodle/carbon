import { resolvePlacement } from '@core/placement';
import type { World } from '@core/model/world';

/**
 * Where an entity sits on the Column: the band (and biome, when there is one)
 * of each of its places, and whether that is pinned or inferred. It is read
 * from the placement resolver (`src/core/placement`, `resolvePlacement`), the
 * one source of placement in carbon; this file only reshapes its result for
 * the Column's cells and the Bench's "where" line.
 *
 *  - A biome's place is its own band and itself.
 *  - Another entity's places are its biomes (each in its band), plus every
 *    band it is placed in that none of those biomes covers.
 *  - Unplaced entities go to the Inbox.
 */
export interface Place {
  band: string;
  biome?: string;
}

export interface Placement {
  places: Place[];
  /** True when the resolver inferred the place (nothing pins it). */
  inferred: boolean;
  /** For inferred placements: the entity the place came through (for the tooltip). */
  via?: string;
}

export const INBOX: Placement = { places: [], inferred: false };

const cache = new WeakMap<object, Map<string, Placement>>();

/**
 * Placements of every entity, keyed by id (one pass for the Column). Memoised
 * per resolution: the resolver returns the same object while no placing input
 * changes, so a rename or a state change costs nothing here.
 */
export function placementsOf(world: World): Map<string, Placement> {
  const all = resolvePlacement(world);
  const hit = cache.get(all);
  if (hit) return hit;
  const bandOfBiome = (id: string): string | undefined => all[id]?.bands[0];
  const out = new Map<string, Placement>();
  for (const p of Object.values(all)) {
    const e = world.entities[p.id];
    if (!e || p.mode === 'unplaced') {
      out.set(p.id, INBOX);
      continue;
    }
    const places: Place[] = [];
    const covered = new Set<string>();
    const biomes = e.kind === 'biome' ? [e.id] : p.biomes;
    for (const biome of biomes) {
      const band = bandOfBiome(biome);
      if (!band || !p.bands.includes(band)) continue;
      places.push({ band, biome });
      covered.add(band);
    }
    for (const band of p.bands) if (!covered.has(band)) places.push({ band });
    const inferred = p.mode === 'inferred';
    const via = inferred ? p.via[0] : undefined;
    out.set(p.id, { places, inferred, ...(via ? { via } : {}) });
  }
  cache.set(all, out);
  return out;
}

/** The placement of one entity. Deterministic: same world, same answer. */
export function placementOf(world: World, entityId: string): Placement {
  return placementsOf(world).get(entityId) ?? INBOX;
}
