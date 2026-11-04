import type { Entity } from '../model/entity';
import { heightValue, HeightSchema } from '../model/fields';
import type { World } from '../model/world';

/**
 * The checks' view of placement: which bands each entity is in, and whether
 * that place is stated or inferred. Package W2 owns the real resolver
 * (`src/core/placement`); `localPlacement` below is a deterministic stand-in
 * with the same shape, and `fromResolver` adapts W2's resolver once it lands.
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

/** A finite height for a set of bands: the middle of their extent, clamped at the endless ends. */
export function heightOf(bands: readonly string[], spans: readonly BandSpan[]): number | undefined {
  const mine = spans.filter((s) => bands.includes(s.id));
  if (mine.length === 0) return undefined;
  const bottom = Math.min(...mine.map((s) => s.bottom));
  const top = Math.max(...mine.map((s) => s.top));
  const finite = spans.flatMap((s) => [s.bottom, s.top]).filter(Number.isFinite);
  const lo = finite.length ? Math.min(...finite) : 0;
  const hi = finite.length ? Math.max(...finite) : 0;
  const b = Number.isFinite(bottom) ? bottom : Math.min(lo, top) - 64;
  const t = Number.isFinite(top) ? top : Math.max(hi, bottom) + 64;
  return (b + t) / 2;
}

/** Relations that say outright where an entity is. */
const STATED = ['in_band', 'in_biome', 'found_in', 'lives_in'];

/**
 * Relations an entity's place can be inferred through, and in which direction:
 * `out` follows the relation to its target, `in` from its source.
 */
const INFER: { type: string; dir: 'out' | 'in' }[] = [
  { type: 'drops', dir: 'in' }, // a material is where the creatures that drop it are
  { type: 'made_from', dir: 'out' }, // an item is where its materials are
  { type: 'unlocks', dir: 'in' }, // a capability is where the feat that unlocks it is
  { type: 'requires', dir: 'out' },
  { type: 'counters', dir: 'out' },
];

/**
 * A deterministic placement resolver: stated places first (a band is itself, a
 * biome its `band` field, then `in_band`, `in_biome`, `found_in`, `lives_in`),
 * then, for entities still without a place, inference through route steps and
 * the relations above, repeated until nothing changes.
 */
export const localPlacement: PlacementFn = (world) => {
  const places = new Map<string, Place>();
  const get = (id: string): Entity | undefined =>
    Object.prototype.hasOwnProperty.call(world.entities, id) ? world.entities[id] : undefined;
  const bandsOfTarget = (id: string): string[] => {
    const t = get(id);
    if (!live(t)) return [];
    if (t.kind === 'band') return [t.id];
    if (t.kind === 'biome') {
      const b = typeof t.fields.band === 'string' ? get(t.fields.band) : undefined;
      const fromRel = t.relations.filter((r) => r.type === 'in_band').map((r) => r.target);
      return [
        ...(live(b) && b.kind === 'band' ? [b.id] : []),
        ...fromRel.filter((x) => get(x)?.kind === 'band'),
      ];
    }
    return [];
  };
  const entities = Object.values(world.entities)
    .filter(live)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const e of entities) {
    const bands = new Set<string>();
    if (e.kind === 'band') bands.add(e.id);
    else {
      for (const b of bandsOfTarget(e.kind === 'biome' ? e.id : '')) bands.add(b);
      for (const r of e.relations)
        if (STATED.includes(r.type)) for (const b of bandsOfTarget(r.target)) bands.add(b);
    }
    if (bands.size > 0) places.set(e.id, { bands: [...bands].sort(), inferred: false });
  }
  // Inference, to a fixpoint (bounded by the number of entities).
  const inbound = new Map<string, { type: string; from: string }[]>();
  for (const e of entities)
    for (const r of e.relations) {
      const l = inbound.get(r.target) ?? [];
      l.push({ type: r.type, from: e.id });
      inbound.set(r.target, l);
    }
  for (let round = 0; round < entities.length; round++) {
    let changed = false;
    for (const e of entities) {
      if (places.has(e.id)) continue;
      const bands = new Set<string>();
      const add = (id: string): void => {
        for (const b of places.get(id)?.bands ?? []) bands.add(b);
      };
      // An item's route: the earliest step whose needs have a place.
      if (Array.isArray(e.fields.route)) {
        for (const step of e.fields.route as { needs?: unknown }[]) {
          const needs = Array.isArray(step.needs)
            ? (step.needs as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          needs.forEach(add);
          if (bands.size > 0) break;
        }
      }
      if (bands.size === 0)
        for (const { type, dir } of INFER) {
          if (dir === 'out') for (const r of e.relations) if (r.type === type) add(r.target);
          if (dir === 'in')
            for (const r of inbound.get(e.id) ?? []) if (r.type === type) add(r.from);
        }
      if (bands.size > 0) {
        places.set(e.id, { bands: [...bands].sort(), inferred: true });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return places;
};

/**
 * Adapts a per-entity resolver (W2's `resolvePlacement`, whatever its exact
 * return shape) to a PlacementFn: `pick` maps one result to bands + inferred.
 */
export function fromResolver<R>(
  resolve: (world: World, id: string) => R,
  pick: (r: R) => Place | null,
): PlacementFn {
  return (world) => {
    const out = new Map<string, Place>();
    for (const id of Object.keys(world.entities).sort()) {
      const p = pick(resolve(world, id));
      if (p && p.bands.length > 0)
        out.set(id, { bands: [...p.bands].sort(), inferred: p.inferred });
    }
    return out;
  };
}
