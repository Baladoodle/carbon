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

---

## 1. What I built

**Placement** (`src/core/placement/`): §0 above. `resolve.ts` (the resolver and
helpers), `commands.ts` (`placement.pin` / `placement.unpin`, added to the
registry with one line), `index.ts` (the public surface).

**Codex** (`src/renderer/views/codex/`, key `3`):

- **Tabs:** `All` plus one per kind, each with the count of rows matching the
  filter. `[` / `]` switch tabs. `All` shows the common columns, so cross-kind
  queries (`state:decided`) have somewhere to land; it is the default, which
  also keeps foundation's smoke test (click `glide` in the Codex) working.
- **Columns from `schemaOf(world)`** (`columns.ts`): name, identity, the band
  (from placement; inferred placements in `--text-3`), every kind field and
  every attribute. Numeric fields are mono and right-aligned. Fields the AI
  wrote (`ai_fields`) show in `--ai`. A schema.json field becomes a column
  with no code change (tested).
- **Virtualised:** fixed 32px rows, fixed table layout, spacer rows above and
  below the visible window (+8 overscan). The e2e test loads 2,000 entities and
  checks fewer than 80 rows are in the DOM, and that `shift+g` reaches the last
  row in under 2 s.
- **Filter** (`query.ts`, `/` to focus): the language in §2 below. Errors are
  underlined in place (a mirror behind the input) and listed underneath; terms
  with errors are ignored, so the rest still filters. A query that narrows to
  one kind (`lane:items`) switches to that tab.
- **Sort:** click a header, or `o` on the cursor column (asc → desc → off).
  Empty values sort last both ways; enums sort by option order (rarity common
  → legendary); ties by name, then id.
- **Keys:** `j`/`k` and arrows move the cursor row (the Bench follows), `h`/`l`
  the cursor column, `g`/`shift+g` first/last, `enter` edits the cursor cell,
  `x` toggles the row's selection, `shift+j`/`shift+k` extend it,
  `ctrl+a` selects every visible row, `escape` clears, `n` adds an entity of
  the tab's kind and starts editing its name, `p` pins an inferred placement,
  `shift+p` unpins, `s` sets state, `d` marks decided, `space` aims a spread.
  Mouse: click (cursor), ctrl-click (toggle), shift-click (range), double-click
  (edit), the checkbox column (toggle).
- **Inline edit through commands:** text, long text (first line shown, full
  text edited), number (with the field's min/max), range (`2..5`, `2-5`, `4`),
  height (`-inf`, `+inf`, `∞`), list (comma-separated), boolean (toggles on
  `enter`), enum and ref (the kit's Combobox), attributes. Enter commits one
  `entity.update` / `entity.setField` / `entity.setAttribute`, escape cancels,
  blur cancels. A bad value is refused with the reason (red border, toast) and
  nothing changes. Climate and route are edited on the Bench / Climate view.
- **Bulk state** (`StateDialog.tsx`, `planBulkState`): one transaction (one
  undo step) over the selection, or the cursor row. Keys in the dialog: `i`,
  `s`, `d`, `e`, `g` (states no selected entity can reach are disabled).
  Deciding asks for a Why, used for the entities that have none. The graveyard
  asks for a kill reason from `taste.reasons` (`1`–`7`; `0` then a note).
  Entities that can't move (wrong transition, missing required fields) are
  left out and named in the result toast.
- **Selection → spread:** see §3.

**Climate** (`src/renderer/views/climate/`, key `2`):

- One band at a time, as underline tabs ordered sky → depths (as on the
  Column); bands without valid edges come last. `[` / `]` switch band; the
  choice persists per viewer.
- The plane: temperature across (cold → warm), moisture up (dry → wet), as a
  very low-contrast two-axis gradient. Four tiny axis words (`cold`, `warm`,
  `dry`, `wet`) are the only labels: without them the axes can't be read.
- Biomes in the band (by placement, so `in_band` biomes count too) are glass
  panels (`--surface-2` at 70%, 8px blur, hairline border). Each lists the
  materials, creatures and structures placed in it (graveyard excluded).
- **Drag** the body to move, the edges and corners to resize. The draft is
  local while dragging and committed as **one** `entity.setField climate` on
  release (one undo step). Values snap to hundredths and stay inside 0..1 and
  at least 0.05 wide.
- **Overlaps** are drawn as a warn-coloured hatch over the shared climate and
  the regions get a warn border; **empty climate** (no biome covers it) is a
  faint diagonal hatch, like the Column's unwritten ends.
- **Keys:** `j`/`k` select the next/previous biome (the Bench follows),
  arrows move it by 0.05, shift+arrows resize from the warm/wet corner, `n`
  adds a biome in the largest empty climate, `enter` opens it on the Bench,
  `escape` deselects (or cancels a drag), `space` aims a spread (§3). Biomes in
  the band with no climate are listed under the plane; clicking one places it
  in the largest empty climate.
- `geometry.ts` (pure): overlaps, empty regions (coordinate compression, then
  merged), new-region placement, move/resize with snapping and clamping.

## 2. The filter language

```
state:decided band:"Low Sky" lane:items
```

| Form | Meaning |
|---|---|
| `key:value` | a filter; terms are ANDed |
| `key:a,b` | either value (OR) |
| `-term` | not |
| `key:>3`, `>=`, `<`, `<=`, `=` | numeric comparison |
| `key:2..5` | numeric range (overlap for ranges and Y) |
| `word`, `"two words"` | free text in name, identity, id or tags |

**Keys:** `state`, `kind`, `lane` (`items`, `item` and `Items` all work),
`band` and `biome` (id or name, from placement; `none` for unplaced), `placed`
(`pinned`, `inferred`, `none`), `y` (the placement's Y range), `name`,
`identity`, `description`, `why`, `id`, `tag`, `ai` (`yes`/`no`: has AI-written
fields), `origin` (`user`/`ai`), `has:<field|attribute|relation>`, **every kind
field** in the schema (typed: enums check their options, numbers/ranges/heights
compare, lists contain, refs match id or name, steps match text or needs),
**every attribute**, and **every relation type** (`made_from:"Vent Glass"`).

**Errors** have exact spans and say how to fix them: `unknown filter "stat";
did you mean state?`, `no state "decidd"; did you mean decided?`,
`rarity: no option "mythic"`, `"5..1" is not a range like 2..5`,
`state: can't compare with >`, `unclosed quote`, `a value is missing after ","`.

`parseQuery` never throws (property-tested on arbitrary strings, with every
span inside the source), `formatQuery` round-trips, and a negated term matches
exactly the complement.

## 3. Selection to spread (for W5)

`src/renderer/state/ui.ts` gained (additively) `spreadSpot: Spot | null` and
`startSpreadAt(spot)`, which sets the spot and switches to the Spread view.

- **Codex** `space`: one row → `{ type: 'entity', entity }`; several selected
  rows → `{ type: 'selection', entities }` (the cursor row when nothing is
  selected).
- **Climate** `space`: the selected biome's region, or with nothing selected
  the largest empty climate in the band →
  `{ type: 'region', band, climate }` (a gap to Fill).

W5 reads it with `useUi((s) => s.spreadSpot)` and should clear it
(`setUi({ spreadSpot: null })`) once a spread has started from it, if it wants
`space` from the Spread view itself to mean something else. W1's Column can use
the same `startSpreadAt({ type: 'cell', band, lane })`.

## 4. Decisions

1. **Pins are relations.** `placement.pin` writes `in_band` / `in_biome`; no
   new entity field or file format. An explicit relation is a pin, whoever
   wrote it. Bands and biomes are placed by their own fields and aren't
   pinnable through the command.
2. **A biome doesn't list itself in `biomes`**, and a band does list itself in
   `bands`, so `y` is always defined from `bands`. Consumers that want "the
   biome of X or X itself" add it.
3. **Inference sources** follow SYSTEM §3's example ("highest-danger place
   among the earliest steps of its route") and extend it to `made_from`,
   `requires` and `unlocked_by` with the same rule; `found_in`, `lives_in` and
   `dropped_by` are unions (a material is wherever it's found). `pairs_with`
   and `conflicts` never place anything.
4. **Graveyard sources still place things** (a dead creature still shows
   where its drops are). Climate leaves graveyard entities out of a biome's
   signature list.
5. **The filter language lives in the Codex folder**
   (`views/codex/query.ts`), pure TypeScript with no React or DOM, because
   `src/core/query/` isn't mine. It imports only `@core`. If W6's palette or
   W4 want it, it can move to core unchanged.
6. **Bulk state skips rather than fails.** A transaction is all-or-nothing, so
   I plan it first and leave out entities that can't move, naming them after.
   The rest still change in one undo step.
7. **Codex `d`** marks the selection decided (asks for Why). If W1's Bench also
   binds `d`, the newest-mounted layer wins; with the Codex view active, that's
   the Codex.
8. **Tabs hand focus back.** Clicking a Radix tab keeps focus on the strip,
   which then eats the arrow keys. Both views move focus back to their
   content (a `tabIndex=-1` container without a focus ring) after a tab
   change.
9. **Kind counts** show 0 too: they change what you do next (which tab to
   open) and the strip stays stable while you type a filter.

## 5. Shared-contract changes (all additive)

| File | Change |
|---|---|
| `src/core/commands/registry.ts` | `...placementCommands` (the one line) |
| `src/core/model/model.test.ts` | added `placement.pin` / `placement.unpin` to the "every command has a label" table (it's keyed by every command type, so every package adding commands must add a line here) |
| `src/renderer/state/ui.ts` | `UiState.spreadSpot: Spot \| null` (default `null`) and `startSpreadAt(spot)` |

No changes to `src/core/model`, `src/shared/ipc.ts` or `package.json`.

## 6. Tests

- **Vitest:** 52 tests in my 4 files (placement 23 including 3 property tests
  over random worlds with broken bands and `requires` cycles; query 13
  including 3 property tests; columns 8; geometry 8 including 3 property
  tests). Whole suite: 120 tests in 17 files. `src/core/placement` coverage:
  100% lines and functions, 92% branches.
- **E2E** (`e2e/world.spec.ts`): 11 tests, 2 tagged `@smoke` (Codex filter,
  inline errors and tab follow; Climate band switching and overlaps). The rest
  cover inline edit + undo + persistence, the enum picker, bulk state with one
  undo, space → Spread view, 2,000-entity virtualisation, drag to move and
  resize with one undo each, keyboard nudge / new biome / spread.
- **Screens:** `docs/screens/world-codex.png` (items, two rows selected, an
  inferred band dimmed), `world-codex-error.png` (an inline filter error),
  `world-climate.png` (Hollows with an overlap and empty climate hatched).

## 7. Known gaps

- The Codex doesn't remember sort or column widths between sessions, and
  columns can't be hidden or reordered.
- Climate and route fields aren't inline-editable in the Codex (Climate view
  and Bench).
- The filter input has no autocomplete for keys or values (the errors
  suggest the nearest key/state/lane instead).
- The e2e tests check that `space` switches to the Spread view; that the spot
  arrives is only checked through the code path, since `uiStore` isn't exposed
  to Playwright. W5's integration test should assert it from its side.
- Climate's arrow-key nudges are one undo step each (a drag is one step).

**API spend: $0.00** (this package makes no AI calls).
