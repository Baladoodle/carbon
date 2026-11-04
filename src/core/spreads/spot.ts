import type { Move, Spot } from '../ai/moments';
import { SpotSchema } from '../ai/moments';
import { slugify, type EntityId } from '../model/ids';
import { ENTITY_KINDS, LANE_OF_KIND, type EntityKind } from '../model/kinds';
import { getEntity, type World } from '../model/world';
import { deepEqual } from '../util/json';
import { err, ok, type Result } from '../util/result';
import { MOVE_DEFS } from './moves';

/**
 * The spot of a spread: where it is aimed (docs/EXPERIENCE.md §4). Other views
 * hand a spot to the Spread view through UI state (see
 * src/renderer/views/spread/start.ts); everything here is pure.
 */

/** Existing entities the spot names, in the spot's order, unique. */
export function spotEntities(world: World, spot: Spot): EntityId[] {
  const ids =
    spot.type === 'entity'
      ? [spot.entity]
      : spot.type === 'selection' || spot.type === 'note'
        ? spot.entities
        : [];
  return [...new Set(ids)].filter((id) => getEntity(world, id) !== undefined);
}

/** The band a spot sits in, if it has one. */
export function spotBand(world: World, spot: Spot): EntityId | undefined {
  if (spot.type === 'cell' || spot.type === 'region') return spot.band;
  for (const id of spotEntities(world, spot)) {
    const band = bandOf(world, id);
    if (band) return band;
  }
  return undefined;
}

/** An entity's band: itself, its `band` field, an `in_band` relation, or its biome's band. */
export function bandOf(world: World, id: EntityId): EntityId | undefined {
  const e = getEntity(world, id);
  if (!e) return undefined;
  if (e.kind === 'band') return e.id;
  const field = e.fields.band;
  if (typeof field === 'string' && getEntity(world, field)?.kind === 'band') return field;
  const rel = e.relations.find((r) => r.type === 'in_band' && getEntity(world, r.target));
  if (rel) return rel.target;
  for (const r of e.relations) {
    if (r.type !== 'in_biome' && r.type !== 'found_in' && r.type !== 'lives_in') continue;
    const t = getEntity(world, r.target);
    if (t?.kind === 'biome' && typeof t.fields.band === 'string') return t.fields.band;
    if (t?.kind === 'band') return t.id;
  }
  return undefined;
}

/** The kind of entity candidates for this spot become. */
export function spotKind(world: World, spot: Spot): EntityKind {
  switch (spot.type) {
    case 'cell':
      return ENTITY_KINDS.find((k) => LANE_OF_KIND[k] === spot.lane) ?? 'item';
    case 'region':
      return 'biome';
    default: {
      const first = spotEntities(world, spot)[0];
      return (first ? getEntity(world, first)?.kind : undefined) ?? 'item';
    }
  }
}

const pct = (n: number): string => n.toFixed(2).replace(/^0/, '');

/** A short human name for the spot (shown in the spread bar and the history). */
export function spotLabel(world: World, spot: Spot): string {
  const name = (id: string): string => getEntity(world, id)?.name ?? id;
  switch (spot.type) {
    case 'cell':
      return `${name(spot.band)} · ${spot.lane}`;
    case 'region': {
      const c = spot.climate;
      return `${name(spot.band)} · ${pct(c.temperature.min)}–${pct(c.temperature.max)} × ${pct(c.moisture.min)}–${pct(c.moisture.max)}`;
    }
    case 'entity':
      return name(spot.entity);
    case 'selection': {
      const names = spot.entities.map(name);
      if (names.length <= 2) return names.join(' + ');
      return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
    }
    case 'note':
      return spot.note.length > 60 ? `${spot.note.slice(0, 57)}…` : spot.note;
  }
}

/** A filename-safe slug of the spot, for spread ids. */
export function spotSlug(spot: Spot): string {
  switch (spot.type) {
    case 'cell':
      return slugify(`${spot.band}-${spot.lane}`);
    case 'region':
      return slugify(`${spot.band}-region`);
    case 'entity':
      return slugify(spot.entity);
    case 'selection':
      return slugify(`${spot.entities[0] ?? 'selection'}-and-${spot.entities.length - 1}`);
    case 'note':
      return slugify(spot.note.split(/\s+/).slice(0, 5).join(' ')) || 'note';
  }
}

/** Checks a spot against the world and the move: it exists, and the move can aim at it. */
export function checkSpot(world: World, spot: Spot, move: Move): Result<null> {
  const parsed = SpotSchema.safeParse(spot);
  if (!parsed.success) return err('spot.invalid', 'not a valid spot');
  const def = MOVE_DEFS[move];
  if (!def.spots.includes(spot.type))
    return err('spot.move', `${def.label} can't aim at a ${spotTypeName(spot)}`, {
      move,
      spot: spot.type,
    });
  if (spot.type === 'cell' || spot.type === 'region') {
    const band = getEntity(world, spot.band);
    if (band?.kind !== 'band') return err('spot.band', `no band "${spot.band}"`);
  }
  const named =
    spot.type === 'entity'
      ? [spot.entity]
      : spot.type === 'selection' || spot.type === 'note'
        ? spot.entities
        : [];
  const missing = named.filter((id) => !getEntity(world, id));
  if (missing.length > 0) return err('spot.missing', `no entity "${missing[0] ?? ''}"`);
  const count = spotEntities(world, spot).length;
  if (count < def.minEntities)
    return err(
      'spot.entities',
      def.minEntities === 1
        ? `${def.label} needs an entity`
        : `${def.label} needs ${def.minEntities} entities`,
    );
  return ok(null);
}

function spotTypeName(spot: Spot): string {
  switch (spot.type) {
    case 'cell':
      return 'Column cell';
    case 'region':
      return 'Climate region';
    case 'selection':
      return 'selection';
    case 'entity':
      return 'single entity';
    case 'note':
      return 'note';
  }
}

/** Moves that can aim at this spot in this world. */
export function movesFor(world: World, spot: Spot): Move[] {
  return (Object.keys(MOVE_DEFS) as Move[]).filter((m) => checkSpot(world, spot, m).ok);
}

/** The move a spot starts with: Fill for places, Alloy for a pair, Vary otherwise. */
export function defaultMove(world: World, spot: Spot): Move {
  if (spot.type === 'cell' || spot.type === 'region' || spot.type === 'note') return 'fill';
  if (spot.type === 'selection' && spotEntities(world, spot).length === 2) return 'alloy';
  return 'vary';
}

/**
 * The spot implied by UI state when no view handed one over: an explicit spot
 * wins; otherwise a multi-selection, then a single selection or the focus.
 */
export function spotFromUi(
  world: World,
  ui: { spot?: Spot | null; selection: readonly EntityId[]; focus: EntityId | null },
): Spot | null {
  if (ui.spot) return ui.spot;
  const sel = ui.selection.filter((id) => getEntity(world, id));
  if (sel.length > 1) return { type: 'selection', entities: [...sel] };
  const one = sel[0] ?? (ui.focus && getEntity(world, ui.focus) ? ui.focus : null);
  return one ? { type: 'entity', entity: one } : null;
}

/** Whether two spots aim at the same place. */
export const sameSpot = (a: Spot, b: Spot): boolean => deepEqual(a, b);
