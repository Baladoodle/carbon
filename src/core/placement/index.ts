/**
 * Placement (docs/SYSTEM.md §3): where every entity sits on Y.
 *
 *   resolvePlacement(world: World): Readonly<Record<EntityId, Placement>>
 *
 * Pure, deterministic, memoised per `world.entities`. See `resolve.ts` for the
 * rules and the reason codes, and `commands.ts` for `placement.pin` /
 * `placement.unpin`.
 */
export {
  resolvePlacement,
  placementOf,
  knownBands,
  bandRange,
  bandAt,
  entitiesInBand,
  entitiesInBiome,
  isInBand,
  PLACEMENT_REASONS,
  PIN_RELATIONS,
  type Placement,
  type Placements,
  type PlacementMode,
  type PlacementReason,
  type KnownBand,
  type YRange,
} from './resolve';
export { placementCommands, pinPlacement, unpinPlacement, pinRelations } from './commands';
