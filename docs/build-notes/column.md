# Build notes: `column` (W1)

Branch `claude/blissful-einstein-8u27ty-column`, from the merged foundation.
Owns `src/renderer/views/column/` and `src/renderer/bench/`. `npm run check`
passes. API spend: **$0.00** (everything runs on `FakeAiGateway`).

---

## 1. What's built

### The Column (`views/column/`)

| File | What |
|---|---|
| `scale.ts` | The symmetric log scale `u = sign(y)·log10(1 + \|y\|/16)`, its inverse, Y formatting (`−512`, `1.2k`, `±∞`), ruler ticks (m·10^k, labels only at decades, spaced by pixels), snapping to two significant digits |
| `placement.ts` | **Local placement adapter** (see §3): explicit band/biome → `in_biome` → `in_band`; else inferred through `found_in`/`lives_in`, then route needs, `made_from`, `requires`, `unlocks` (two hops, cycle-safe); else the Inbox. One O(n) pass for the whole world |
| `layout.ts` | Pure geometry: band spans, rows (bands plus hatched **unwritten** gaps, including the endless ends), the frame (content px at a zoom, endless ends drawn 1.1 decades past the outermost finite edge), the cell index (entity → band × lane, Inbox, graveyard on/off), chip packing with ellipsis and a `+N` overflow chip, margin note stacking |
| `cursor.ts` | Keyboard navigation: `j`/`k` walk the entities of each cell (or the empty cell) down/up through rows; `h`/`l` change lane keeping the row and index; lane −1 is the band column |
| `edges.ts` | Edges (shared between touching bands), their limits, clamping + snapping, keyboard nudges, the commands that move an edge (one transaction for both bands), new bands in a gap (`n`) or drawn on the ruler |
| `lanes.ts` | Shown lanes, their order, saved layouts and the graveyard switch, in `carbon.json` under `column` (lenient parsing: bad entries drop, nothing is lost) |
| `model.ts` | World → model (zoom-independent), model + zoom + width → geometry. **Cell layouts are cached by content**, so an edit re-lays only the cells it touched |
| `stress.ts` | The deterministic 2,000-entity stress world (40 bands tiling ±∞, 80 biomes, explicit / inferred / Inbox placements, every state) |
| `view.tsx`, `Layers.tsx`, `Margin.tsx`, `LanesMenu.tsx`, `store.ts`, `measure.ts`, `column.css` | The view |

Behaviour, per EXPERIENCE §2 and VISUAL §6.1–6.2:

- An SVG strip: fine ruler on the left (ticks on the symlog scale, mono labels
  at decades only, **Y 0 a single accent tick with no label**), band names and
  spans in a label column, the depth tint per band, lanes with their labels
  (from the kind schema's plural), hatched unwritten heights fading at the
  endless ends.
- Entity chips: state glyph + name. **Inferred** chips have a dashed outline and
  `--text-3` names, and their tooltip says what they're inferred via. Graveyard
  chips are faded and dashed. Items are grouped by subkind (one line each).
- **Bands are resized by dragging their edges** (1px lines that thicken on
  hover, accent while dragging; `esc` cancels; one undo step moves both bands of
  a shared edge) and **created by dragging on the ruler** in unwritten heights,
  or with `n` on a hatched row. `alt+k`/`alt+j` (top edge) and
  `alt+shift+k`/`alt+shift+j` (bottom edge) do it from the keyboard.
- **Lanes**: the corner menu (and the palette) shows/hides lanes, toggles the
  graveyard, saves / uses / deletes layouts; `alt+h`/`alt+l` move the lane under
  the cursor.
- **Notes** (`useNotes()`) sit in the right margin at their height (`note.y`,
  else their entity's chip, else its band), stacked without overlap, coloured by
  severity (`--ai` for critique). Click puts the entity on the Bench; hover shows
  dismiss.
- **The Inbox**: a strip under the Column, aligned with the lanes (bands
  without edges go in its band column). `i` jumps there.
- **Keys**: `j k h l` (and arrows), `+`/`=` and `−` zoom (anchored), `0` Y 0,
  `n` new entity in the cell (or a band in a gap; the name field is focused and
  selected), `space` spread at the cell, `enter` edit on the Bench, `i` Inbox.
  `ctrl+wheel` zooms around the pointer; scrolling is native.
- The cursor and the Bench follow each other: landing on an entity puts it on
  the Bench; focusing an entity elsewhere (palette, Codex, a Bench link) moves
  the cursor to it and scrolls it into view.
- Empty world: "No bands yet. `n` to add one."

### The Bench (`bench/`)

| File | What |
|---|---|
| `value.ts` | Text ⇄ value for each field type (number with typographic minus, height with `±∞`/`inf`, lists, …), validation with the same zod rules as the commands, common fields described like kind fields |
| `relations.ts` | Relation types a kind may hold; targets the rules allow (kinds, no self, no duplicate, **no cycle** for acyclic types); incoming relations read from the other side |
| `critique.ts` | Critique result → `Note`s with stable ids, published under `ai:<id>` |
| `slots.ts` | One request at a time per entity per channel (§2.4) |
| `ai.ts` | The AI controller: suggest one / three, fill, accept / reject, critique on finish / state change / demand. Takes its gateway and dispatcher as parameters (unit-tested on `FakeAiGateway`) |
| `controller.ts` | The app wiring (the renderer `ai` client, `transact`) and field / attribute commits, with in-flight tracking so a critique always sees your last edit |
| `fields.tsx`, `Relations.tsx`, `StateControl.tsx`, `Bench.tsx`, `store.ts`, `bench.css` | The UI |

- **Schema-driven form** for every kind (`schemaOf(world).kinds[kind].fields`):
  text, longtext, number, height, list, enum, boolean, ref (entity picker),
  range, climate (temperature × moisture), steps (route steps, each with the
  entities it needs). Name is the 20px title, identity the line under it. Edits
  commit on blur / enter as one command each; invalid input shows the error
  under the field and isn't sent.
- **Attributes** from the kind's definitions whose `when` holds (armor gets
  `defense`, weapons `damage`), plus any extra attribute already on the entity.
- **Relations**: outgoing (removable chips), incoming (inverse labels), and a
  picker: a type `Select` limited to what the kind may hold and a target
  `Combobox` limited to what the rules allow.
- **State machine**: the `…` menu offers the legal transitions; `d` opens the
  **Why gate** (from idea it passes through shaped in the same undo step); kills
  take a reason by its key (`1`–`7`, `0` + a few words); fields still needed for
  a refused transition are marked "Needed to be decided" under them.
- **`ai` markers** next to the label of every field in `ai_fields` (and a
  violet rule on the control), until you edit it.
- **AI moments** (only through the renderer `ai` client):
  - `tab`: a ghost suggestion inline (`Input`'s suggestion state); `tab` accepts
    (`source: 'ai'`), `tab` again asks for another (`avoid` = values already
    shown), `esc` dismisses. Non-text fields show "→ value" under the control.
  - `shift+tab`: three alternatives under the field, `1`/`2`/`3` picks.
  - `ctrl+enter`: fill proposals for every empty field, waiting in each field
    with accept / reject (or `tab` / `esc` while it has focus), plus Accept all
    (one transaction) / Reject all.
  - Critique when you **finish editing** (focus moves to another entity, the
    Bench loses focus, or the Bench closes, *after changes*), on `ctrl+s`, after
    every **state change**, and on demand with `?`. Results go to
    `publishNotes('ai:<id>')` and show on the Bench and in the margin.
  - Every proposal is checked against its field before it's shown.
  - Undo covers all of it (accepting is an ordinary command).
- Keys while editing: `alt+↓`/`alt+↑` next / previous field (tab belongs to
  suggestions), `esc` leaves the field. Delete is in the menu and the palette,
  with an Undo toast.

## 2. Decisions

1. **Pure logic lives in my folders**, not `src/core`, because I don't own a
   core path. It's still framework-free (no React or DOM in `scale`, `layout`,
   `cursor`, `edges`, `lanes`, `placement`, `stress`, `model`, `value`,
   `relations`, `critique`, `slots`, `ai`) and unit/property tested. Coverage
   thresholds apply only to `src/core`, so they aren't counted there; the hardening
   phase may want to move `layout`/`scale` to `src/core/column/`.
2. **Scale constant 16**: linear within ±16, a decade per unit beyond. The
   sample world's bands all fit one screen at the default zoom.
3. **Rows of the endless ends**: drawn 1.1 decades past the outermost finite
   edge and faded, rather than scrolling forever.
4. **Entities with several places** (a material found in two bands) show in each
   band. An endless-sky band's chips align to its finite (bottom) edge.
5. **Navigation**: `j`/`k` step through entities, not just rows (otherwise
   there's no keyboard way to reach the 2nd entity of a cell). Lane −1 (the band
   column) selects bands themselves.
6. **`i` (Inbox)** is bound by the Column: EXPERIENCE §9 lists it with no
   owner, and the Inbox lives on the Column.
7. **`n` on items** inherits the subkind of the item under the cursor, else
   leaves it empty (the Bench shows it's needed for idea).
8. **Request channels**: "one request at a time per entity" is per entity *and*
   channel: field requests (suggest one, suggest three, fill) cancel each other;
   critique has its own slot. Otherwise finishing an edit would cancel a fill
   you just asked for. Unasked critiques fail silently; `?` reports errors.
9. **Critique on finishing** runs only if you changed the entity since its last
   critique (`edited` mark set when a change is sent). Leaving an unchanged
   entity never calls the AI.
10. **`d` from idea** runs idea → shaped → decided as one transaction, so it
    follows the lifecycle diagram and undoes in one step.
11. **Layouts are per world** (`carbon.json` → `column`), as foundation
    decision 10 suggested; changing lanes is undoable like any setting.
12. **Kill counts**: a kill from the Bench records `killed.reason` (the label)
    but doesn't increment `taste.reasons[].count` — W5 owns taste and its
    counting; integration can add it to the same transaction.
13. **Tooltips on 2,000 chips**: one custom tooltip element driven by pointer
    events, not a Radix tooltip per chip.
14. **The kit's `Input` remounts its `<input>` when a suggestion appears** (it
    wraps itself in `.ui-suggest`), which drops focus. The Bench restores focus
    and the caret around it (`fields.tsx`), so I didn't touch the kit. The
    polish pass may prefer to make `Input` always render the wrapper.

## 3. Placement: the swap for W2

`placement.ts` → `placementOf(world, id)` / `placementsOf(world)` returning
`{ places: { band, biome? }[], inferred, via? }`. Nothing else in the Column or
the Bench reads relations to place entities. At integration, make these two
functions call W2's `resolvePlacement` and map its result; the tests in
`column.test.ts › placement` describe the expected sample-world placements and
can be adjusted to W2's rules.

## 4. Shared-contract changes (all additive)

| File | Change |
|---|---|
| `src/renderer/state/ui.ts` | `UiState.spreadRequest: { spot: Spot; seq } \| null` and `startSpread(spot)` (sets it and switches to the Spread view). `space` on the Column calls it. **W5 should read `spreadRequest`** (W2's Codex can call `startSpread` too) |
| `e2e/harness.ts` | `LaunchOptions.worldDir`: copy a world from anywhere (the generated stress world) |
| `e2e/smoke.spec.ts` | Two assertions that targeted the stubs now target the real Column (`[data-band]`) and Bench (the name input) |

No changes to `src/core/model`, `src/shared/ipc.ts` or `package.json`.

## 5. Performance (SYSTEM §9)

Measured by `e2e/column.spec.ts › performance` on the stress world
(2,000 entities) under xvfb, 1440×900:

- **Panning: 60.4 fps** (rAF-driven scroll over the whole column for 3 s;
  the display's cap). Native scrolling, the SVG on its own layer, rows and
  cells culled to the viewport ± 800 px (quantized, so small scrolls don't
  re-render), memoized cells.
- **Command round trip: median ~13 ms** in the suite (dispatch → main →
  patch applied in the renderer and the response back, with the Column
  re-rendering), max ~25–38 ms; ~6.5 ms median in a fresh, idle launch (vs ~4.4
  ms with no Column mounted). The test waits 1 s after the pan test and
  discards 5 warm-up runs. This is the closest budget to its limit; the
  remaining cost is `columnModel` (placements + cell index) on each patch, which
  could be made incremental if it grows.

## 6. Tests

- **Unit / property (Vitest): 61** — `column.test.ts` 41 (10 property tests:
  scale symmetry/monotonicity/inverse, snapping, rows covering the axis, chips
  never overlapping and accounting for every entity, margin stacking, the
  cursor visiting every stop, edge clamping, nudges, drawn bands), `bench.test.ts`
  20 (value parsing and format ⇄ parse round-trips, every offered relation is
  accepted by the commands, critique notes, request slots, and the AI controller
  on `FakeAiGateway`: tab / tab / tab, three, fill accept / reject / all,
  critique on leaving, stale-request cancellation, AI off, `ai: false` fields).
- **End to end: 23** in `e2e/column.spec.ts`, 2 tagged `@smoke` (the Column
  renders and navigates; tab suggests, accepts with the marker, undoes). They
  cover creation with `n`, edge drags and nudges, drawing bands, lanes and
  layouts, lane moves, zoom, `0`, `space`, `i`, margin notes, every field type,
  relations, the Why gate with missing fields, kills, fill, three, critique on
  finishing and `ctrl+s`, the empty world, and the two performance budgets.
- **Screenshots** (`docs/screens/`, scale factor 1, sample world unless noted):
  `column-sample`, `column-notes`, `column-bench`, `column-bench-suggest`,
  `column-bench-three`, `column-bench-fill`, `column-empty` (new world),
  `column-stress` (2,000 entities).

## 7. Known gaps

- **Attributes' live consequences** (EXPERIENCE §3) need W3's numbers engine;
  the Bench shows and edits the values only. Integration: show each formula
  that reads the attribute, evaluated for this entity.
- **Placement** is the local adapter until W2's resolver is swapped in (§3).
- **Notes dismissal** uses `dismissNote` (session only); persistence is W6's.
- Overlapping bands are drawn on top of each other (no special layout); W6's
  checks should flag them.
- `localStorage` remembers the zoom; the scroll position is kept for the
  session only.
- Chip names truncate heavily with all 7 lanes and the Bench open at 1440 px;
  the full name is in the tooltip and on the Bench. Hiding lanes or the Bench
  (`b`) gives them room.
