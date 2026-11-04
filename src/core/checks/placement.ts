import type { Entity } from '../model/entity';
import { heightValue, HeightSchema } from '../model/fields';
import type { World } from '../model/world';
import { resolvePlacement } from '../placement';

/**
 * The checks' view of placement: which bands each entity is in, and whether
 * that place is stated or inferred. It is read from the placement resolver
 * (`src/core/placement`), the one source of placement in carbon.
 */
export interface Place {
  /** Band ids, sorted. Empty: the entity has no place. */
  bands: string[];
  inferred: boolean;
}

export type PlacementFn = (world: World) => ReadonlyMap<string, Place>;

export interface BandSpan {
  id: string;
  name: string;
  bottom: number;
  top: number;
}

const live = (e: Entity | undefined): e is Entity => !!e && e.state !== 'graveyard';

/** Bands with both edges set, bottom to top (graveyard bands left out). */
export function bandSpans(world: World): BandSpan[] {
  const out: BandSpan[] = [];
  for (const e of Object.values(world.entities)) {
    if (e.kind !== 'band' || !live(e)) continue;
    const b = HeightSchema.safeParse(e.fields.y_bottom);
    const t = HeightSchema.safeParse(e.fields.y_top);
    if (!b.success || !t.success) continue;
    out.push({ id: e.id, name: e.name, bottom: heightValue(b.data), top: heightValue(t.data) });
  }
  return out.sort((a, b) => a.bottom - b.bottom || a.top - b.top || a.id.localeCompare(b.id));
}

const finiteRange = new WeakMap<readonly BandSpan[], [number, number]>();

/** The lowest and highest finite band edges (0, 0 with none), computed once per spans list. */
function finiteEdges(spans: readonly BandSpan[]): [number, number] {
  let r = finiteRange.get(spans);
  if (!r) {
    const finite = spans.flatMap((s) => [s.bottom, s.top]).filter(Number.isFinite);
    r = finite.length ? [Math.min(...finite), Math.max(...finite)] : [0, 0];
    finiteRange.set(spans, r);
  }
  return r;
}

/** A finite height for a set of bands: the middle of their extent, clamped at the endless ends. */
export function heightOf(bands: readonly string[], spans: readonly BandSpan[]): number | undefined {
  if (bands.length === 0) return undefined;
  let bottom = Infinity;
  let top = -Infinity;
  for (const s of spans)
    if (bands.includes(s.id)) {
      bottom = Math.min(bottom, s.bottom);
      top = Math.max(top, s.top);
    }
  if (bottom === Infinity && top === -Infinity) return undefined;
  const [lo, hi] = finiteEdges(spans);
  const b = Number.isFinite(bottom) ? bottom : Math.min(lo, top) - 64;
  const t = Number.isFinite(top) ? top : Math.max(hi, bottom) + 64;
  return (b + t) / 2;
}

const resolved = new WeakMap<World['entities'], ReadonlyMap<string, Place>>();

/**
 * Placement for the checks, from `resolvePlacement`: every placed entity's
 * bands (sorted) and whether the place is inferred. Memoised per
 * `world.entities`, like the resolver itself.
 */
export const resolvedPlaces: PlacementFn = (world) => {
  const hit = resolved.get(world.entities);
  if (hit) return hit;
  const out = new Map<string, Place>();
  for (const p of Object.values(resolvePlacement(world)))
    if (p.bands.length > 0)
      out.set(p.id, { bands: [...p.bands].sort(), inferred: p.mode === 'inferred' });
  resolved.set(world.entities, out);
  return out;
};
