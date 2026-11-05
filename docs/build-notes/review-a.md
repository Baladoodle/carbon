# Build notes: `review-a` (Phase 3, hardening W1 column + W2 world)

Branch `claude/blissful-einstein-8u27ty-review-a`. Scope: the Column and the
Bench (W1), placement, Climate and the Codex (W2), and their e2e specs.
API spend: **$0.00** (fake AI and fixtures only).

- **Defects found and fixed, each with its test:** §1
- **Known gaps closed (integrate §10):** §2
- **Measurements:** §3
- **Coverage, keyboard reach, tests:** §4
- **Changes outside my folders, and decisions:** §5
- **Found outside my scope (for the coordinator):** §6
- **Still open:** §7

Every defect below was first shown by a test that failed on the old code
(re-checked by stashing the fix where the test was written after). No test
was skipped, weakened or deleted. Three existing assertions encoded a defect
and now assert the corrected rule; each is named in its row.

---

## 1. Defects

| # | Defect | Test that shows it | Fix |
|---|---|---|---|
| 1 | **Truncated names broke characters in half.** `fitText` cut at UTF-16 units, so an emoji, a flag or a ZWJ sequence became a lone surrogate or a broken glyph. Band labels cut at 12 units whatever their width | property test `layoutCell › never cuts a character or a grapheme in half` (failed on `🇯🇵a`) | `fitText` cuts only between graphemes (`Intl.Segmenter`); band labels measure with `fitText` (`measureBand`) |
| 2 | **Codex `d` refused every idea** ("can't go from idea to decided"), while the Bench's `d` decides an idea through shaped in one step | `columns.test › decides ideas through shaped, in the same transaction` | `planBulkState` plans idea → shaped → decided (checking what both need); the dialog offers decided for ideas. The assertion `needsWhy(['glide','vent-glass']) === false` encoded the defect; it is now `needsWhy(['glide'])` |
| 3 | **Climate arrow keys lost presses** faster than a round trip (each built on the rendered rect), and each press was its own undo step | `world.spec › climate: a burst of arrow keys moves by every press, as one undo step` | `views/column/burst.ts`: a live draft per burst, committed as one command after 600 ms of quiet; `ctrl+z` before it's sent drops it |
| 4 | **Column `alt+k`/`alt+j`:** one undo step per press | `column.spec › a burst of alt+k moves the edge by every press, as one undo step` | the same `Burst`, previewed through the edge-drag path |
| 5 | **Climate `escape` and a click on the empty plane didn't deselect**: the selection fell back to the Bench focus, which selecting had just set | `world.spec › climate escape and a click on the empty plane deselect the biome` | a deselect stops following the current focus; a click anywhere but a biome deselects |
| 6 | **Clicking the current tab** (Climate band, Codex kind) left focus in the tab strip, so arrows switched bands instead of nudging | same test (ArrowRight switched to Hollows) | any pointer-up on the strip hands focus back to the plane / table |
| 7 | **Codex inline edit of long text joined its paragraphs**: a one-line `<input>` strips line breaks | `world.spec › codex edits long text inline without losing its line breaks` | a `longtext` cell edit: a textarea opening over the rows below; enter commits, shift+enter breaks a line |
| 8 | **The Column flipped bands with inverted edges** and drew them, while the resolver (and Climate, the Codex, the checks) treats them as edgeless: the band showed, with its entities in the Inbox | property `bands agree with the resolver` (failed on `+inf`, `0`) | `bandSpan` reads the resolver's `bandRange`. The unit assertion that expected `9..5` to flip into `5..9` now expects no span |
| 9 | **An outside edit replaced text you were typing on the Bench**, silently (SYSTEM §4: conflicts with unsaved edits ask) | `column.spec › an outside edit of a field you are typing in asks which to keep` | `bench/outside.ts` stamps entities touched by `cause: 'external'` patches and resets; a text field you're typing in keeps your text and asks inline: Keep mine / Use theirs. Leaving the field doesn't decide. Carbon's own changes (accepts, undo) replace the draft as before |
| 10 | **Critique notes outlived their entity** (status count, notes store), and a critique out when its entity was deleted was published after | `core/bench › stale critiques`; `bench.test › drops a critique that lands after its entity was deleted` (a gateway that answers as asked, then late); `column.spec › deleting an entity takes its critique notes with it` | the controller withdraws `ai:<id>` notes of missing entities on every change of the entity set and cancels their requests; `critique()` drops a result for a missing entity |
| 11 | **Codex numbers:** a range with a negative upper end (`-5..-2`) was refused (`[\d.]+` swallowed the `..`); the typographic minus the ruler and cells display was refused in the filter and replaced only once in cells; `0x10`, `0b11`, `Infinity` passed as numbers | `columns.test › reads numbers as the Bench and the ruler write them`; `query.test › numbers in filters` | a strict number pattern in ranges; cells and filter values use the Bench's `parseNumber` |
| 12 | **Climate hid the biomes of a band without edges**: such bands are tabs, but a biome showed only where the resolver placed it, which is nowhere. `n` there made an invisible biome | `world.spec › climate: a biome made on a band without edges shows on its plane`; `climate/bands.test` | a biome belongs to a band when the resolver places it there or it names the band (its `band` field or an `in_band` pin). `climate/bands.ts`, pure |

## 2. Known gaps closed (integrate §10)

1. **Pure logic in `src/core`.** `scale`, `layout`, `placement` (the Column's
   reshaping), `cursor`, `edges`, `lanes`, `model` → `src/core/column/`;
   `value`, `relations`, `critique` → `src/core/bench/`; the stress world →
   `src/core/testing/stress.ts`. Only imports changed (`git mv`, history kept).
   The core coverage threshold now applies to them.
2. **Incremental cell indexing.** `columnModel(world, prev)`: when an edit
   moves nothing (same placements object from the resolver, no band changed,
   same settings and schema), only the cells of the changed entities are
   re-indexed; every other cell keeps its list. The cell-layout cache is now
   keyed by list identity (element-wise compare as the fallback) instead of a
   signature string built over every entity, and the Inbox is cached too.
   Property test: over random renames, state changes (graveyard shown and
   hidden), subkinds, identities and relation edits, the patched model equals
   a fresh build. A mutation (no re-sort) fails it.
3. **Chip names at 1440 px with every lane and the Bench.** Two parts:
   - **Lanes sized by need** (`laneWidths`, max–min fair water-filling): each
     lane wants its widest whole chip or its header label (rounded to 8 px so
     a rename rarely shifts lanes); short-name and empty lanes take only what
     they need and the rest goes to long names. Property-tested (exact sum,
     ≥ min, no lane gains at a needier lane's expense). It helps most when
     lanes differ; in the sample world every lane wants more than its fair
     share of ~700 px, so they still cap equally there.
   - **Reveal:** the chip under the cursor shows its whole name, raised over
     its neighbours, drawn above every cell and ignoring the pointer. So the
     keyboard reads every name; the mouse already had the hover tooltip.
4. **Climate nudges merge** into one undo step per burst (defects 3–4).
5. **The Codex remembers** each tab's sort and column widths (`codex/prefs.ts`,
   read leniently, property-tested on junk), with the tab and filter it
   already remembered. A header's right edge drags to resize (double-click
   resets); `>` / `<` widen and narrow the cursor column; the palette resets
   it.

## 3. Measurements

The 2,000-entity stress world, Electron under xvfb, 1440×900, median of 30
after 5 warm-ups (`column.spec › performance`):

| Measure | Before (phase start) | Main after the other reviews merged, alone | This branch on that main | Budget (SYSTEM §9) |
|---|---|---|---|---|
| Round trip, rename (the Column redraws) | 14.4 ms | 15.5–21.0 ms (2 of 3 runs failed) | 9.9–11.0 ms (five runs) | 16 ms |
| Round trip, identity (not drawn) | 6.4 ms | — | 5.9–9.0 ms | 16 ms |
| Column panning | 60.6 fps | — | 60.4 fps | 50 fps |
| Codex `shift+g` over 2,000 rows | < 2 s | — | < 2 s | 2 s (W2's own) |

Before the merge this branch measured 9.6–10.0 ms for a rename. Main's newer
work added per-patch cost in the renderer; a CDP profile per rename then
showed the Column's share (two passes over the entities, lane demands for
every cell, the margin re-sorting ~3,400 check notes) and I removed it:
one pass, per-cell cached demands, a reused margin stack. In Node, per
rename: Column model 3.2 → 0.8 ms, geometry 2.0 → 0.6 ms.

## 4. Coverage, keyboard reach, tests

- **Coverage** of `src/core/column`, `src/core/bench`, `src/core/placement`:
  99.1% lines, 99.6% functions; every file ≥ 94.9% lines and ≥ 97.5%
  functions (`model.ts` was 31% lines before the tests in this phase).
- **Keyboard and palette reach:** Climate's move/resize keys and `enter` are
  listed in the palette now; placing a biome without climate (mouse only) is
  a palette action per biome; the Bench's notes ("Dismiss the notes on X")
  and relations ("Unrelate X (pairs with)") are palette actions. Codex
  widths: `>`, `<`, palette reset.
- **Tests (on the latest merged main):** unit and property tests 646, all
  passing in `npm run check` (about 45 of them mine, several property
  tests); e2e 105, all passing (15 of them mine, in `column.spec` and
  `world.spec`). Rename round trip in that full run: 9.2 ms median; panning
  60.7 fps.

## 5. Outside my folders, and decisions

**Files outside my folders** (all small and additive):

- `e2e/column.spec.ts`, `e2e/world.spec.ts` (mine) import from the new core
  paths.
- No change to `src/core/model`, `src/shared/ipc.ts`, `package.json`, the kit
  or the shell. `src/core/column` and `src/core/bench` are new folders.

**Decisions:**

1. **Bursts** commit after 600 ms of quiet; a press for another biome or edge
   commits the waiting one first; leaving the view, changing band or
   selection, or starting a drag sends it; `ctrl+z` while it waits drops it
   (registered by the view, so it beats the shell's undo only then).
2. **Codex sort and widths are the viewer's settings** (localStorage, like
   the tab and filter already were), not the world's `carbon.json`: sorting
   must not become an undo step or a file write.
3. **An inverted band waits in the Inbox** on the Column, as everywhere else;
   it isn't flipped.
4. **Outside-edit conflicts** are asked inline per field, for the text fields
   (text, longtext, number, height, list). Leaving the entity without
   choosing keeps the file's version.
5. **Rebase:** `--force-with-lease` was refused by the session's permission
   policy, so instead of rewriting the pushed branch I merged the latest main
   into it. I checked the merge's tree is byte-identical to the rebased one
   (`git diff` empty); the history has one merge commit instead of being
   linear.

## 6. Found outside my scope

- **Inverted band edges are valid in the store** (`validateWorld` doesn't
  check `y_bottom < y_top`). The Column and Climate now treat such a band as
  edgeless; a mechanical check naming it would tell the user why (W6).
- **The kit's `Tabs` keeps focus on a click of the current tab**, so arrows
  then move between tabs. I handed focus back in Climate and the Codex; other
  views with tabs over keyboard surfaces may want the same (kit).
- **The status line counts entities with `Object.keys` on every world
  change** (`shell/StatusLine.tsx`): about 1.2 ms per command on 2,000
  entities, the largest single item in a rename's renderer profile. A count
  kept from patches (or memoised per `entities` object) would remove it.
  W4's state-change trigger (`ai/triggers.ts`) also walks every entity per
  patch (~0.4 ms).
- **A flaky property test in W4's area:** `src/core/prompts/stream.test.ts ›
  a truncated stream yields only the complete items` failed once on the
  merged main with counterexample `[[{"{":-0}],1530009722]`: JSON turns `-0`
  into `0`, so the deep-equal fails. It passes on other seeds. The test (or
  its arbitrary) should treat `-0` and `0` as equal, or exclude `-0`.
- **Codex selection survives filtering**: bulk state and spread act on
  selected rows the filter now hides (the count is shown). A design call,
  not changed.

## 7. Still open

- **Truncation with every lane and the Bench at 1440 px** is reduced, not
  gone, when every lane has long names: there is less room than names. The
  reveal and the tooltip show them whole; hiding a lane or the Bench gives
  room.
- **Outside-edit conflicts** cover the Bench's text fields; range, climate
  and route drafts and attributes still follow the stored value.
- **Docs screenshots** of the Column (lane widths) weren't regenerated; the
  polish phase regenerates every screen.
- The Column's scroll position is still kept for the session only.

## 8. The coordinator's requests

1. **Bench drafts against outside edits** (review-c's proposal: publish
   dirty drafts to a store, and have W6's `PlatformRuntime` open the conflict
   dialog). Already covered Bench-side by defect 9, without touching the
   platform. `bench/outside.ts` tells outside patches (`cause: 'external'`,
   and `world:reset`) from carbon's own. A field you're typing in keeps your
   draft and asks inline, Keep mine / Use theirs, and leaving the field
   decides nothing, so a blur can no longer overwrite the outside value
   unasked. I didn't add the store-plus-dialog route on top: it would ask the
   same question twice. If the dialog is preferred for consistency with
   whole-file conflicts, the draft state in `useTypedDraft` is the one place
   to publish from.
2. **`transact` resolves before its patch reaches the mirror.** I checked
   every call site in the Column, Bench, Climate and Codex. None reads the
   world back in a way that loses data: the Bench's commits already wait
   (`landedIn`), and the Burst commits wait. The create paths (`n` in the
   Column, Climate and Codex, drawing a band, placing or saving a climate)
   set a cursor or selection to an id the mirror didn't have yet, so the
   Column's cursor fell back to the Y 0 row for a frame. They now
   `await whenRev(r.rev)` first. This was transient (no failing test was
   possible), so it's hardening, not a counted defect.
3. **Round-trip test reliability.** `column.spec › a command round-trips in
   under 16 ms` now takes the median of 80 runs after 10 warm-ups (it was 30
   after 5). On failure it prints p10, p25, the median, p75, p90 and max.
   The budget stays a 16 ms median. Headroom on the final merged main:
   rename median 8.5–11.0 ms (p90 13–18), identity 5.6–6.1 ms, over four
   runs including one inside the full suite.
