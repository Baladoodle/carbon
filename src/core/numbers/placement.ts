import type { Entity } from '../model/entity';
import { heightValue } from '../model/fields';
import type { World } from '../model/world';
import { resolvePlacement } from '../placement';

/**
 * The small adapter between the numbers engine and placement
 * (`src/core/placement/`): an entity's `band` in formulas is the lowest band
 * the resolver places it in, and its `tier` is that band's tier. Bands are
 * ordered by `y_bottom` for tiers.
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

/** The engine's resolver: `resolvePlacement`, the lowest band each entity sits in. */
export const resolvedPlacement: PlacementResolver = (world) => {
  const tiers = bandTiers(bandOrder(world));
  const out = new Map<string, Placed>();
  for (const p of Object.values(resolvePlacement(world))) {
    const band = p.bands[0] ?? null;
    out.set(p.id, {
      band,
      tier: band === null ? null : (tiers.get(band) ?? null),
      inferred: p.mode === 'inferred',
    });
  }
  return out;
};
