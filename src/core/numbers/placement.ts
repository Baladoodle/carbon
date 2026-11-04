import type { Entity } from '../model/entity';
import { heightValue } from '../model/fields';
import { getEntity, type World } from '../model/world';

/**
 * The small adapter between the numbers engine and placement (W2's
 * `src/core/placement/`). Until that resolver is merged, bands are ordered by
 * `y_bottom` and an entity is placed only by an explicit band:
 *
 * - a band is in itself
 * - a biome is in its `band` field
 * - anything else is in the target of its first `in_band` relation, or else in
 *   the band of the biome its first `in_biome` relation points at
 *
 * Swapping in the real resolver means passing a different `PlacementResolver`
 * to the engine; nothing else changes.
 */
export interface Placed {
  /** The band the entity is in, or null if it has no place yet. */
  band: string | null;
  /** The band's tier: 0 for the band at Y 0 (or the lowest above it), +1 above, −1 below. */
  tier: number | null;
  /** Whether the place was inferred from relations rather than set explicitly. */
  inferred: boolean;
}

export type PlacementResolver = (world: World) => Map<string, Placed>;

const h = (v: unknown, fallback: number): number =>
  typeof v === 'number' || v === '-inf' || v === '+inf' ? heightValue(v) : fallback;

/** Bands from the lowest to the highest: by `y_bottom`, then `y_top`, then id. */
export function bandOrder(world: World): Entity[] {
  return Object.values(world.entities)
    .filter((e) => e.kind === 'band' && e.state !== 'graveyard')
    .sort((a, b) => {
      const d = h(a.fields.y_bottom, 0) - h(b.fields.y_bottom, 0);
      if (d !== 0 && !Number.isNaN(d)) return d < 0 ? -1 : 1;
      const t = h(a.fields.y_top, 0) - h(b.fields.y_top, 0);
      if (t !== 0 && !Number.isNaN(t)) return t < 0 ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** Tier per band id: the first band whose top is above 0 is tier 0. */
export function bandTiers(bands: Entity[]): Map<string, number> {
  let zero = bands.findIndex((b) => h(b.fields.y_top, 0) > 0);
  if (zero < 0) zero = bands.length;
  return new Map(bands.map((b, i) => [b.id, i - zero]));
}

function explicitBand(world: World, e: Entity): string | null {
  const isBand = (id: unknown): id is string =>
    typeof id === 'string' && getEntity(world, id)?.kind === 'band';
  if (e.kind === 'band') return e.id;
  if (e.kind === 'biome') return isBand(e.fields.band) ? e.fields.band : null;
  const inBand = e.relations.find((r) => r.type === 'in_band' && isBand(r.target));
  if (inBand) return inBand.target;
  const inBiome = e.relations.find((r) => r.type === 'in_biome');
  if (inBiome) {
    const biome = getEntity(world, inBiome.target);
    if (biome?.kind === 'biome' && isBand(biome.fields.band)) return biome.fields.band;
  }
  return null;
}

/** The interim resolver: explicit bands only (see above). */
export const explicitPlacement: PlacementResolver = (world) => {
  const tiers = bandTiers(bandOrder(world));
  const out = new Map<string, Placed>();
  for (const e of Object.values(world.entities)) {
    const band = explicitBand(world, e);
    out.set(e.id, {
      band,
      tier: band === null ? null : (tiers.get(band) ?? null),
      inferred:
        e.kind !== 'band' &&
        e.kind !== 'biome' &&
        !e.relations.some((r) => r.type === 'in_band') &&
        band !== null,
    });
  }
  return out;
};
