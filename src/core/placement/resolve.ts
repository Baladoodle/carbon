import type { Entity } from '../model/entity';
import { heightValue, HeightSchema, StepsSchema } from '../model/fields';
import type { EntityId } from '../model/ids';
import { getEntity, type World } from '../model/world';

/**
 * Placement: where every entity sits on Infinite's Y axis (docs/SYSTEM.md §3).
 *
 * An entity's place is its explicit band or biome if it has one (`pinned`),
 * otherwise it is `inferred` from its relations by fixed rules, otherwise it is
 * `unplaced`. The resolver is pure and deterministic: the same world always
 * gives the same placements, whatever order entities were added in.
 */

/** How a placement was arrived at. */
export type PlacementMode = 'pinned' | 'inferred' | 'unplaced';

/**
 * Why an entity is where it is, as a short machine-readable code.
 *
 * | code | mode | meaning |
 * |---|---|---|
 * | `band.edges` | pinned | a band, placed by its own `y_bottom`/`y_top` |
 * | `band.no_edges` | unplaced | a band whose edges are missing or inverted |
 * | `biome.band` | pinned | a biome, placed by its `band` field |
 * | `pin.relation` | pinned | explicit `in_band` / `in_biome` relations |
 * | `infer.found_in` | inferred | a material, where its `found_in` biomes and bands are |
 * | `infer.lives_in` | inferred | a creature, where its `lives_in` biomes and bands are |
 * | `infer.dropped_by` | inferred | a material, where the creatures that drop it live |
 * | `infer.route` | inferred | the highest-danger place among the earliest placeable step of its route |
 * | `infer.made_from` | inferred | the highest-danger place among its materials |
 * | `infer.requires` | inferred | the highest-danger place among what it requires |
 * | `infer.unlocked_by` | inferred | the highest-danger place among the feats that unlock it |
 * | `unplaced.pin_unknown` | unplaced | pinned, but no pinned target has a known band |
 * | `unplaced.no_source` | unplaced | nothing to infer a place from |
 */
export const PLACEMENT_REASONS = [
  'band.edges',
  'band.no_edges',
  'biome.band',
  'pin.relation',
  'infer.found_in',
  'infer.lives_in',
  'infer.dropped_by',
  'infer.route',
  'infer.made_from',
  'infer.requires',
  'infer.unlocked_by',
  'unplaced.pin_unknown',
  'unplaced.no_source',
] as const;
export type PlacementReason = (typeof PLACEMENT_REASONS)[number];

/** A closed Y interval. The endless ends are `-Infinity` / `Infinity`. */
export interface YRange {
  min: number;
  max: number;
}

export interface Placement {
  id: EntityId;
  mode: PlacementMode;
  reason: PlacementReason;
  /**
   * The hull of `bands` on Y: from the lowest bottom to the highest top. `null`
   * exactly when `bands` is empty (the entity is unplaced). A band's own range.
   */
  y: YRange | null;
  /** Known bands it sits in, ordered bottom to top. A band lists itself. */
  bands: EntityId[];
  /** Biomes it sits in (ordered by id), where known. A biome does not list itself. */
  biomes: EntityId[];
  /** The entities the placement was read from (relation targets, route needs, …), ordered by id. */
  via: EntityId[];
}

/** Every entity's placement, by id. */
export type Placements = Readonly<Record<EntityId, Placement>>;

/** A band with usable edges. */
export interface KnownBand {
  id: EntityId;
  name: string;
  y: YRange;
  /** `danger.max` / `danger.min`, or -1 when unset. */
  danger: { min: number; max: number };
}

/** The relation types that pin an entity by hand. */
export const PIN_RELATIONS = ['in_band', 'in_biome'] as const;

/** The edges of a band, if both are set and bottom < top. */
export function bandRange(band: Entity): YRange | null {
  if (band.kind !== 'band') return null;
  const lo = HeightSchema.safeParse(band.fields.y_bottom);
  const hi = HeightSchema.safeParse(band.fields.y_top);
  if (!lo.success || !hi.success) return null;
  const min = heightValue(lo.data);
  const max = heightValue(hi.data);
  return min < max ? { min, max } : null;
}

function dangerOf(band: Entity): { min: number; max: number } {
  const d = band.fields.danger;
  if (d && typeof d === 'object') {
    const { min, max } = d as { min?: unknown; max?: unknown };
    if (typeof min === 'number' && typeof max === 'number') return { min, max };
  }
  return { min: -1, max: -1 };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(byId);

/** Bands with usable edges, ordered bottom to top (ties by top, then id). */
export function knownBands(world: World): KnownBand[] {
  const out: KnownBand[] = [];
  for (const e of Object.values(world.entities)) {
    if (e.kind !== 'band') continue;
    const y = bandRange(e);
    if (y) out.push({ id: e.id, name: e.name, y, danger: dangerOf(e) });
  }
  return out.sort((a, b) => a.y.min - b.y.min || a.y.max - b.y.max || byId(a.id, b.id));
}

/** A partial result while resolving: bands and biomes, before ordering. */
interface Place {
  bands: Set<string>;
  biomes: Set<string>;
}

/** The pieces of a placement besides its ids, for building results. */
type Outcome =
  | {
      kind: 'placed';
      mode: 'pinned' | 'inferred';
      reason: PlacementReason;
      place: Place;
      via: string[];
    }
  | { kind: 'unplaced'; reason: PlacementReason; biomes: Set<string>; via: string[] };

class Resolver {
  private readonly bands: Map<string, KnownBand>;
  private readonly order: Map<string, number>;
  /** Clean results, safe to reuse from any path. */
  private readonly memo = new Map<string, Outcome>();
  /** Ids on the current resolution path → their depth. */
  private readonly path = new Map<string, number>();
  /** Inbound edges, built once: target → sources, per relation type. */
  private readonly inbound = new Map<string, Map<string, string[]>>();

  constructor(private readonly world: World) {
    const known = knownBands(world);
    this.bands = new Map(known.map((b) => [b.id, b]));
    this.order = new Map(known.map((b, i) => [b.id, i]));
    const ids = Object.keys(world.entities).sort(byId);
    for (const id of ids) {
      const e = world.entities[id];
      if (!e) continue;
      for (const r of e.relations) {
        if (r.type !== 'drops' && r.type !== 'unlocks') continue;
        let m = this.inbound.get(r.type);
        if (!m) this.inbound.set(r.type, (m = new Map<string, string[]>()));
        const list = m.get(r.target) ?? [];
        if (!list.includes(id)) list.push(id);
        m.set(r.target, list);
      }
    }
  }

  private sources(type: 'drops' | 'unlocks', target: string): string[] {
    return this.inbound.get(type)?.get(target) ?? [];
  }

  /** Resolves one entity. `hit.min` collects the shallowest path depth a cycle reached. */
  resolve(id: string, hit: { min: number }): Outcome {
    const cached = this.memo.get(id);
    if (cached) return cached;
    const onPath = this.path.get(id);
    if (onPath !== undefined) {
      // A cycle: this branch contributes nothing. Remember how far up it reached,
      // so results that depended on the cut aren't reused from other paths.
      hit.min = Math.min(hit.min, onPath);
      return { kind: 'unplaced', reason: 'unplaced.no_source', biomes: new Set(), via: [] };
    }
    const depth = this.path.size;
    this.path.set(id, depth);
    const inner = { min: Infinity };
    const out = this.compute(id, inner);
    this.path.delete(id);
    if (inner.min >= depth) this.memo.set(id, out);
    hit.min = Math.min(hit.min, inner.min);
    return out;
  }

  private compute(id: string, hit: { min: number }): Outcome {
    const e = getEntity(this.world, id);
    const none: Outcome = {
      kind: 'unplaced',
      reason: 'unplaced.no_source',
      biomes: new Set(),
      via: [],
    };
    if (!e) return none;
    if (e.kind === 'band') {
      return this.bands.has(e.id)
        ? {
            kind: 'placed',
            mode: 'pinned',
            reason: 'band.edges',
            place: { bands: new Set([e.id]), biomes: new Set() },
            via: [],
          }
        : { kind: 'unplaced', reason: 'band.no_edges', biomes: new Set(), via: [] };
    }

    // 1. Pinned: the biome's band field, or explicit in_band / in_biome relations.
    const pinBands = new Set<string>();
    const pinBiomes = new Set<string>();
    const via = new Set<string>();
    if (e.kind === 'biome' && typeof e.fields.band === 'string') {
      const b = e.fields.band;
      if (this.bands.has(b))
        return {
          kind: 'placed',
          mode: 'pinned',
          reason: 'biome.band',
          place: { bands: new Set([b]), biomes: new Set() },
          via: [b],
        };
      via.add(b);
    }
    for (const r of e.relations) {
      const t = getEntity(this.world, r.target);
      if (!t) continue;
      if (r.type === 'in_band' && t.kind === 'band') {
        via.add(t.id);
        if (this.bands.has(t.id)) pinBands.add(t.id);
      } else if (r.type === 'in_biome' && t.kind === 'biome' && e.kind !== 'biome') {
        via.add(t.id);
        pinBiomes.add(t.id);
        for (const b of this.biomeBands(t)) pinBands.add(b);
      }
    }
    if (via.size > 0) {
      if (pinBands.size > 0)
        return {
          kind: 'placed',
          mode: 'pinned',
          reason: 'pin.relation',
          place: { bands: pinBands, biomes: pinBiomes },
          via: sortedUnique(via),
        };
      return {
        kind: 'unplaced',
        reason: 'unplaced.pin_unknown',
        biomes: pinBiomes,
        via: sortedUnique(via),
      };
    }
    if (e.kind === 'biome') return none;

    // 2. Inferred, by kind.
    const targets = (type: string): string[] =>
      sortedUnique(
        e.relations
          .filter((r) => r.type === type && getEntity(this.world, r.target))
          .map((r) => r.target),
      );
    switch (e.kind) {
      case 'material':
        return (
          this.union('infer.found_in', targets('found_in'), hit) ??
          this.union('infer.dropped_by', this.sources('drops', e.id), hit) ??
          none
        );
      case 'creature':
        return this.union('infer.lives_in', targets('lives_in'), hit) ?? none;
      case 'item':
        return (
          this.route(e, hit) ??
          this.hardest('infer.made_from', targets('made_from'), hit) ??
          this.hardest('infer.requires', targets('requires'), hit) ??
          this.hardest('infer.unlocked_by', this.sources('unlocks', e.id), hit) ??
          none
        );
      case 'capability':
        return (
          this.hardest('infer.requires', targets('requires'), hit) ??
          this.hardest('infer.unlocked_by', this.sources('unlocks', e.id), hit) ??
          none
        );
      case 'structure':
      case 'feat':
        return this.hardest('infer.requires', targets('requires'), hit) ?? none;
    }
  }

  /** The known bands of a biome (its `band` field, else its `in_band` relations). */
  private biomeBands(biome: Entity): string[] {
    const placed = this.resolve(biome.id, { min: Infinity });
    return placed.kind === 'placed' ? [...placed.place.bands] : [];
  }

  /** The place of each source, resolved; biomes and bands count as places themselves. */
  private placesOf(ids: string[], hit: { min: number }): { place: Place }[] {
    const out: { place: Place }[] = [];
    for (const id of ids) {
      const t = getEntity(this.world, id);
      if (!t) continue;
      if (t.kind === 'band') {
        if (this.bands.has(id)) out.push({ place: { bands: new Set([id]), biomes: new Set() } });
        continue;
      }
      const r = this.resolve(id, hit);
      if (r.kind !== 'placed') continue;
      const biomes = new Set(r.place.biomes);
      if (t.kind === 'biome') biomes.add(id);
      out.push({ place: { bands: r.place.bands, biomes } });
    }
    return out;
  }

  /** Everywhere any source is (found_in, lives_in, dropped_by). */
  private union(reason: PlacementReason, ids: string[], hit: { min: number }): Outcome | null {
    const places = this.placesOf(ids, hit);
    if (places.length === 0) return null;
    const place: Place = { bands: new Set(), biomes: new Set() };
    for (const p of places) {
      for (const b of p.place.bands) place.bands.add(b);
      for (const b of p.place.biomes) place.biomes.add(b);
    }
    return { kind: 'placed', mode: 'inferred', reason, place, via: ids };
  }

  /** The single highest-danger band among the sources' places (route, made_from, requires, unlocked_by). */
  private hardest(reason: PlacementReason, ids: string[], hit: { min: number }): Outcome | null {
    const places = this.placesOf(ids, hit);
    if (places.length === 0) return null;
    const candidates = new Set<string>();
    for (const p of places) for (const b of p.place.bands) candidates.add(b);
    const best = [...candidates].sort((a, b) => this.compareDanger(a, b))[0];
    if (best === undefined) return null;
    const biomes = new Set<string>();
    for (const p of places) {
      if (!p.place.bands.has(best)) continue;
      for (const bm of p.place.biomes) if (this.biomeIn(bm, best)) biomes.add(bm);
    }
    return {
      kind: 'placed',
      mode: 'inferred',
      reason,
      place: { bands: new Set([best]), biomes },
      via: ids,
    };
  }

  private biomeIn(biomeId: string, bandId: string): boolean {
    const b = getEntity(this.world, biomeId);
    return b ? this.biomeBands(b).includes(bandId) : false;
  }

  /** Harder first: danger.max, then danger.min, then farther from Y 0, then id. */
  private compareDanger(a: string, b: string): number {
    const A = this.bands.get(a);
    const B = this.bands.get(b);
    if (!A || !B) return byId(a, b);
    const dist = (k: KnownBand): number => {
      const lo = Math.max(k.y.min, -1e15);
      const hi = Math.min(k.y.max, 1e15);
      return Math.abs((lo + hi) / 2);
    };
    return (
      B.danger.max - A.danger.max || B.danger.min - A.danger.min || dist(B) - dist(A) || byId(a, b)
    );
  }

  /** The earliest route step whose needs can be placed decides; the hardest band among them. */
  private route(e: Entity, hit: { min: number }): Outcome | null {
    const steps = StepsSchema.safeParse(e.fields.route);
    if (!steps.success) return null;
    for (const step of steps.data) {
      const needs = sortedUnique((step.needs ?? []).filter((n) => getEntity(this.world, n)));
      const r = this.hardest('infer.route', needs, hit);
      if (r) return r;
    }
    return null;
  }

  /** The finished placement of one entity. */
  placement(id: string): Placement {
    const out = this.resolve(id, { min: Infinity });
    if (out.kind === 'unplaced')
      return {
        id,
        mode: 'unplaced',
        reason: out.reason,
        y: null,
        bands: [],
        biomes: sortedUnique(out.biomes),
        via: sortedUnique(out.via),
      };
    const bands = [...out.place.bands].sort(
      (a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0),
    );
    let min = Infinity;
    let max = -Infinity;
    for (const b of bands) {
      const k = this.bands.get(b);
      if (!k) continue;
      min = Math.min(min, k.y.min);
      max = Math.max(max, k.y.max);
    }
    return {
      id,
      mode: out.mode,
      reason: out.reason,
      y: { min, max },
      bands,
      biomes: sortedUnique(out.place.biomes),
      via: sortedUnique(out.via),
    };
  }
}

const cache = new WeakMap<object, Placements>();

/**
 * Resolves the placement of every entity in the world. Pure, deterministic and
 * memoised per `world.entities` object (worlds are immutable, so a patched world
 * gets a new entities object and a fresh resolution).
 */
export function resolvePlacement(world: World): Placements {
  const hit = cache.get(world.entities);
  if (hit) return hit;
  const r = new Resolver(world);
  const out: Record<EntityId, Placement> = {};
  for (const id of Object.keys(world.entities).sort(byId)) out[id] = r.placement(id);
  Object.freeze(out);
  cache.set(world.entities, out);
  return out;
}

/** One entity's placement, or `undefined` if there's no such entity. */
export const placementOf = (world: World, id: EntityId): Placement | undefined =>
  resolvePlacement(world)[id];

/** Whether an entity's placement includes a band. */
export const isInBand = (p: Placement | undefined, bandId: EntityId): boolean =>
  !!p && p.bands.includes(bandId);

/** The ids of every entity placed in a band (the band itself excluded), ordered by id. */
export function entitiesInBand(world: World, bandId: EntityId): EntityId[] {
  const all = resolvePlacement(world);
  return Object.values(all)
    .filter((p) => p.id !== bandId && p.bands.includes(bandId))
    .map((p) => p.id);
}

/** The ids of every entity placed in a biome (the biome itself excluded), ordered by id. */
export function entitiesInBiome(world: World, biomeId: EntityId): EntityId[] {
  const all = resolvePlacement(world);
  return Object.values(all)
    .filter((p) => p.biomes.includes(biomeId))
    .map((p) => p.id);
}

/** The known band containing height `y` (a band's bottom edge belongs to it), if any. */
export function bandAt(world: World, y: number): KnownBand | undefined {
  return knownBands(world).find((b) => b.y.min <= y && y < b.y.max);
}
