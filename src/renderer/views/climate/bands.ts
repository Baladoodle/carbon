import type { World } from '@core/model/world';
import { knownBands, resolvePlacement } from '@core/placement';

/**
 * Which bands the Climate view offers, and which biomes belong to each. Pure.
 *
 * A biome belongs to a band when the resolver places it there, or when it
 * names the band itself (its `band` field or an `in_band` pin) even though
 * the band has no usable edges yet: such a band is still offered as a tab,
 * and its biomes must show on its plane, or a biome made there with `n`
 * would vanish.
 */

/** The bands, ordered top (sky) to bottom (depths), as on the Column; unknown-edge bands last. */
export function bandsOf(w: World): { id: string; name: string }[] {
  const known = knownBands(w)
    .reverse()
    .map((b) => ({ id: b.id, name: b.name }));
  const rest = Object.values(w.entities)
    .filter((e) => e.kind === 'band' && !known.some((k) => k.id === e.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ id: e.id, name: e.name }));
  return [...known, ...rest];
}

/** The biome ids that belong to a band, ordered by id. */
export function biomesInBand(w: World, band: string): string[] {
  const all = resolvePlacement(w);
  return Object.values(w.entities)
    .filter(
      (e) =>
        e.kind === 'biome' &&
        (all[e.id]?.bands.includes(band) === true ||
          e.fields.band === band ||
          e.relations.some((r) => r.type === 'in_band' && r.target === band)),
    )
    .map((e) => e.id)
    .sort();
}
