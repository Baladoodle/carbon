# Build notes: `world` (W2)

Branch `claude/blissful-einstein-8u27ty-world`. Owns `src/core/placement/`,
`src/renderer/views/climate/` and `src/renderer/views/codex/`.

## 0. The placement contract (pushed first; W1, W4 and W6 depend on it)

```ts
import { resolvePlacement, type Placement } from '@core/placement';

resolvePlacement(world: World): Readonly<Record<EntityId, Placement>>

interface Placement {
  id: EntityId;
  mode: 'pinned' | 'inferred' | 'unplaced';
  reason: PlacementReason;            // short machine-readable code, table below
  y: { min: number; max: number } | null;   // hull of `bands` on Y; ±Infinity for endless ends; null iff unplaced
  bands: EntityId[];                  // known bands, ordered bottom to top; a band lists itself
  biomes: EntityId[];                 // biomes, ordered by id, where known; a biome does not list itself
  via: EntityId[];                    // entities the placement was read from, ordered by id
}
```

- **Pure and deterministic:** the same world gives the same result whatever
  order the entities were inserted in (property-tested). Memoised per
  `world.entities` object, so calling it on every render is cheap.
- **Every entity id has an entry.** `mode === 'unplaced'` ⇔ `bands` is empty ⇔
  `y === null`. Otherwise every band in `bands` is a *known band* (both edges
  set, bottom < top) and `y` is exactly their hull (property-tested).
- **Helpers:** `placementOf(world, id)`, `knownBands(world)` (bottom to top, with
  `y` and `danger`), `bandRange(band)`, `bandAt(world, y)`,
  `entitiesInBand(world, bandId)`, `entitiesInBiome(world, biomeId)`,
  `isInBand(placement, bandId)`, `PLACEMENT_REASONS`, `PIN_RELATIONS`.

**Rules, in order:**

| Kind | Pinned by | Inferred from (first that yields a place wins) |
|---|---|---|
| band | its own `y_bottom` / `y_top` (`band.edges`) | — (`band.no_edges` if missing or inverted) |
| biome | its `band` field (`biome.band`), else `in_band` (`pin.relation`) | — |
| material | `in_band` / `in_biome` (`pin.relation`) | `found_in` (union, `infer.found_in`), then the creatures that `drops` it (union, `infer.dropped_by`) |
| creature | same | `lives_in` (union, `infer.lives_in`) |
| item | same | the earliest route step whose `needs` can be placed (`infer.route`), then `made_from`, `requires`, then the feats that `unlocks` it — each the single **highest-danger** band among the sources |
| capability | same | `requires`, then feats that unlock it (highest danger) |
| structure, feat | same | `requires` (highest danger) |

"Highest danger" compares `danger.max`, then `danger.min`, then distance of the
band's middle from Y 0, then id. The biomes kept are the sources' biomes in
that band. Pins to biomes whose band is unknown give `unplaced.pin_unknown`
(with `biomes` still listed). Cycles (`requires` loops) are cut; a result that
depended on a cut is never reused from another path, which is what keeps the
answer independent of order.

**Reason codes:** `band.edges`, `band.no_edges`, `biome.band`, `pin.relation`,
`infer.found_in`, `infer.lives_in`, `infer.dropped_by`, `infer.route`,
`infer.made_from`, `infer.requires`, `infer.unlocked_by`, `unplaced.pin_unknown`,
`unplaced.no_source`. Inferred ⇔ the reason starts with `infer.`.

**Pinning by hand (commands, in the registry):**

- `placement.pin { id, to?: EntityId[] }` replaces the entity's `in_band` /
  `in_biome` relations with pins to `to` (bands and biomes). Without `to`, it
  pins the current inferred placement: its biomes plus any band those biomes
  don't cover, so the pinned bands equal the inferred ones (property-tested).
  Errors: `placement.own_field` (bands and biomes are placed by their fields),
  `placement.unplaced`, `placement.pinned`, `placement.same`,
  `placement.target`, `placement.not_allowed` (schema relation rules).
- `placement.unpin { id }` removes those pins (`placement.not_pinned` if none).

Pins are ordinary relations, so they persist in the entity file and undo like
any other command. `pinRelations(world, id, to)` previews the relations a pin
would write.
