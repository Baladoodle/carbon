import { z } from 'zod';

/** The eight entity kinds (docs/SYSTEM.md §3). Fixed: schema.json can add fields, not kinds. */
export const ENTITY_KINDS = [
  'band',
  'biome',
  'material',
  'creature',
  'structure',
  'capability',
  'item',
  'feat',
] as const;
export const EntityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKindSchema>;

/** The lifecycle states (docs/EXPERIENCE.md §8). */
export const ENTITY_STATES = ['idea', 'shaped', 'decided', 'exported', 'graveyard'] as const;
export const EntityStateSchema = z.enum(ENTITY_STATES);
export type EntityState = z.infer<typeof EntityStateSchema>;

/** Item subkinds (docs/SYSTEM.md §3). */
export const ITEM_SUBKINDS = ['armor', 'accessory', 'tool', 'weapon', 'consumable'] as const;

/** Column lanes (docs/EXPERIENCE.md §2). Bands are the rows, not a lane. */
export const LANES = [
  'biomes',
  'materials',
  'creatures',
  'structures',
  'capabilities',
  'items',
  'feats',
] as const;
export const LaneSchema = z.enum(LANES);
export type Lane = z.infer<typeof LaneSchema>;

export const LANE_OF_KIND: Record<EntityKind, Lane | null> = {
  band: null,
  biome: 'biomes',
  material: 'materials',
  creature: 'creatures',
  structure: 'structures',
  capability: 'capabilities',
  item: 'items',
  feat: 'feats',
};
