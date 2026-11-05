# Build notes: `integrate` (Phase 2)

Branch `claude/blissful-einstein-8u27ty-integrate`, from the merged foundation
(`8159815`). All six packages are merged with real merges, every stand-in is
replaced by the real thing, and `npm run check` and the full
`npm run test:e2e` pass. The full suite passed three runs in a row on the
final code, and three more before the visual pass. API spend: **$0.00**. Everything runs on the fake AI, or on W4's
real gateway over its offline `replay` API.

- **What was merged, and the conflicts:** §1
- **Stand-ins removed:** §2
- **Bugs found by integrating, and fixed:** §3
- **Keys:** §4
- **Cross-package e2e:** §5
- **The visual pass and the screens:** §6
- **Changes to shared contracts:** §7
- **Decisions:** §8
- **Tests and measurements:** §9
- **Known gaps, across all packages, with rough sizes:** §10

---

## 1. Merges

In the order the plan gives, each with `git merge --no-ff`. I ran
`npm run check` after each merge and fixed what it found before the next one.
No package changed dependencies, so `npm ci` was needed only once, at the
start.

| # | Branch | Merge commit | Conflicts and how I resolved them |
|---|---|---|---|
| 1 | `world` (W2) | `679baf3` | None |
| 2 | `numbers` (W3) | `18e50aa` | `commands/registry.ts` (two `...xCommands` lines) and the label table in `model/model.test.ts`. Both sides were additive, so I kept both |
| 3 | `platform` (W6) | `2af4296` | None |
| 4 | `ai` (W4) | `97567bf` | `shared/ipc.ts` `INVOKE`: W6's store, notes and export channels against W4's `ai:request`. Both additive; I kept both |
| 5 | `spreads` (W5) | `70415d5` | The registry and the label table again (kept both). `state/ui.ts`: W2's `spreadSpot` against W5's `spot`. I settled on **one hand-off, `ui.spot`**, and W2's `startSpreadAt` now sets it. W5's tolerant reader for three names is now a plain reader (§2) |
| 6 | `column` (W1) | `0737201` | `state/ui.ts`: W1's `spreadRequest` and `startSpread` against `spot`. I dropped W1's and pointed the Column's `space` at `startSpreadAt` |

Two things broke after the merges, beyond the conflicts, and I fixed them
before going on:

- **The palette smoke test** (`711e4e3`) asserted the stub Bench's text. The
  real Bench shows the name in an input.
- **The crash-test control in `atomic.test.ts`** was flaky under parallel
  load. A plain 4 MB `writeFile` landed in the page cache before the kill.
  The naive writer now writes in 64 KB chunks, so a kill lands mid-write
  reliably. The atomic writer's assertion is unchanged.

## 2. Stand-ins removed

| Stand-in | Where | Now |
|---|---|---|
| W1's placement adapter (explicit, then 2-hop inference) | `views/column/placement.ts` | A reshaping of `resolvePlacement` (a biome's place is its band and itself; other entities get their biomes in their bands, plus uncovered bands). Memoised per resolution |
| W3's `explicitPlacement` | `core/numbers/placement.ts` | `resolvedPlacement`, reading `resolvePlacement` (band = the lowest band; tier from `bandOrder`) |
| W4's `explicitPlacement` / `defaultPlacement` | `core/context/placement.ts` | `defaultPlacement` reads `resolvePlacement` |
| W5's `bandOf` (its own explicit rules) | `core/spreads/spot.ts` | `resolvePlacement(world)[id].bands[0]` |
| W6's `localPlacement` and `fromResolver` | `core/checks/placement.ts` | `resolvedPlaces`, an adapter over `resolvePlacement`. Used by the checks and the export |
| W6's `noNumbers` default and regex `formulaDependencies` | `core/checks/numbers.ts`, `core/export/spec.ts` | `createNumbersAdapter()` over one incremental `NumbersEngine`: `formulaErrors` (errors only, ids by definition and message), `intentDeviations` (W3's relative tolerance converted to units), and `relevantFormulas` for a spec's formulas |
| W4's fallback `spread` and `patterns` builders | `core/prompts/fallback-spread.ts` (deleted) | W5's `createSpreadPromptBuilders(assemble)` are registered in `PACKAGE_BUILDERS` |
| W4's `renderer/ai/moments.ts` (an unused duplicate of the Bench controller) | deleted | The Bench's `benchAi` is the one renderer path for suggest, fill and critique |
| Two critique-trigger systems (W4's `triggers.ts` and W1's Bench `leaveEntity`/`markEdited`) | `renderer/ai/` and `bench/` | One: `ai/finish.ts` (pure, unit-tested) plus `ai/triggers.ts`. See §8.2 |
| Three spread hand-offs (`spot`, `spreadSpot`, `spreadRequest`) | `state/ui.ts`, `views/spread/handoff.ts` | `ui.spot` and `startSpreadAt(spot)` |
| `CHECK_ADAPTERS = {}` | `palette/Platform.tsx` | The real placement and numbers adapters, shared with the Export view |

The tests of the stand-ins went with them. Each package's own expectations
were re-checked against W2's rules. Four changed, all because the real
resolver infers more, and each change is right:

- W3's golden `placed` goes from 1 to 2 (an item placed through `made_from`).
- `spore-shrine` is pinned to its biome, not inferred.
- The Fourth Accessory Slot is placed by the feat that unlocks it.
- W2's own memo test: an unchanged copy now reuses the resolution.

Wired at integration, beyond the swaps:

- **The `spec_draft` prompt** (W4) sends only the formulas the entities
  depend on, with their values (`specNumbers`), instead of the whole formula
  file.
- **W4's taste block** renders W5's `tasteContext`, so kill-reason examples
  and strength-ordered patterns reach every request (EXPERIENCE §6).
- **Bench live consequences** (W1's gap): `entityConsequences` (new, in
  `core/numbers`). Each constant that reads the entity, and each
  one-entity function applied to it, is shown with its value, live, even
  against an uncommitted formula draft. Only numbers and true/false appear.
- **Kills count their reason in Taste**, from the Bench (W1's gap) and from
  the Codex's bulk graveyard. It's in the same transaction as the kill, so it
  undoes with it. Spreads already did this.

## 3. Bugs found by integrating, and fixed

1. **A watcher race raised false "Changed outside carbon" conflicts on
   carbon's own writes** (W6).
   - **Cause:** a save records its write before the file lands. A scan that
     read while a command was being saved took carbon's own older content for
     an external edit, and inside the settle window merged it into a
     whole-file conflict.
   - **Fix:** a write counter in the disk state. A scan that sees carbon
     write during its reads scans again.
   - **Test:** a regression test in `watcher.test.ts` reproduces the
     interleaving deterministically. It failed before the fix.
2. **Key layers jumped.** `useActions` re-registered a layer at the top of
   the stack whenever a label changed (W5 reported it). The shell's undo
   label changes after every command, so the shell ended up above every
   view. Layers now keep their place. See §4 for the ordering rule.
3. **Codex `d` opened the Bench's Why dialog** after the cursor moved,
   instead of the Codex's bulk decide. The Bench re-mounts with each focused
   entity, and the newest layer won. Layers now have ranks (§4). There's an
   e2e test, and I checked that it fails under the old ordering.
4. **Performance on 2,000 entities collapsed after the merges**: 6 fps
   panning and a 480 ms round trip. Fixes:
   - **Column margin:** laid out once per change, culled to the viewport. Its
     `memo` never held before, because `onOpen` was a fresh closure, so all
     3,400 check notes re-rendered on every scroll step.
   - **Near-duplicate names:** names that differ only in their numbers (a
     series: `Ore 0001`, `Ore 0002`) aren't near-duplicates any more. A
     numbered set of n entities raised O(n²) notes.
   - **Check scheduling:** checks run 120 ms after a burst of patches (at
     most 500 ms late) instead of between the commands of a burst.
   - **Check runner:** lane imbalance in one pass, a cached finite range in
     `heightOf`, and an ASCII sort.
   - **`resolvePlacement`** reuses its result when a patch changes nothing it
     reads. This is property-tested against a fresh resolution, and every
     consumer benefits.
   - **`applyPatch`** copies each container once per patch, not once per op.
     This is property-tested: no mutation of the document or of the op
     values.
   - **Smaller ones:** `useNotes` computes the open notes once per state, and
     the state-change trigger compares only changed entities.
5. **A critique could miss the edit that finished it.** The Bench waited for
   a commit's response, not for its patch to reach the mirror. Added
   `whenRev()` to the world mirror; the Bench's in-flight commits resolve only
   once their patch is applied.
6. **Main modules:** `defineMainModule` was imported back from the eager
   loader (a cycle that crashes the built app; W4 and W6 both worked around
   it). It now lives in `src/main/module-def.ts`.
7. **Test races** that W6's durable, sequential writes exposed:
   - Column and spreads e2e tests read a second file of a transaction, or a
     file right after the UI updated. They now poll.
   - One Column test pressed `tab` twice without waiting for the
     suggestion, so the second `tab` asked for another suggestion instead of
     accepting.
   - Tests that assumed no other notes exist now count the critique's or the
     finding's own notes. The status line's count has a `data-count`.

## 4. Keys

- **Rail keys match EXPERIENCE.md:** Column `1`, Climate `2`, Codex `3`,
  Numbers `4`, Spread `5`, Taste `6`, Export `7`. The reported W2 swap wasn't
  on the merged branch. An e2e test walks all seven.
- **No key twice within a layer.** `duplicateKeys()` reports any key bound
  twice in one layer when the layer registers. There's a unit test for it,
  and an e2e test over every view, the Bench and the overlays fails on any
  report. I checked that the e2e test catches an injected duplicate.
- **Between layers, a fixed order** (`RANK` in `actions.ts`):
  1. The shell is the floor.
  2. The Bench sits above the shell and below the views, except **while focus
     is inside the Bench**, where its keys win.
  3. Views and overlays share the top rank, and the newest wins, so an
     overlay beats the view under it.

  So `d` in the Codex is the Codex's bulk decide, and `ctrl+s` typed in a
  Bench field finishes the Bench edit, even in the Export view.

## 5. Cross-package e2e (`e2e/integration.spec.ts`, 12 tests)

These run on the sample world with the fake AI, except the last, which runs
the real gateway:

1. **Keys:** every rail key opens its view; no layer binds a key twice. This
   one is `@smoke`.
2. **Keys:** a view's key beats the Bench's while you're in the view (Codex
   `d` over several rows).
3. **Building the world across views:**
   - a band drawn on the Column's ruler, in a gap opened by editing High
     Drift on the Bench
   - a biome added with `n` in Climate
   - a material added with `n` in the Codex, named inline
   - the material related `found in` the biome on the Bench
   - the material shown on the Column in the new band, marked inferred
4. **A spread from a Column cell:**
   - `space` hands the cell over, and Fill streams 12 candidates
   - keep two, kill one with reason `3`; the count is in Taste and both kept
     candidates are in the cell on the Column
   - merge two more into one entity, see it on the Column, and undo the merge
     in one step
5. **The Bench:** `tab` suggests, `tab` accepts with the `ai` marker, and
   `ctrl+z` undoes it.
6. **The Bench:** finishing an edit (focus leaves) critiques exactly once.
   The note shows on the Bench and in the margin, and a check note shows on
   the Bench of the entity it concerns.
7. **The Bench:** a kill counts its reason, and undo takes the count back.
8. **Numbers into checks:**
   - a formula typed in the Numbers editor
   - a curve with an intent
   - the attribute off it raises a check note in the margin and on the Bench
   - the Bench shows the live consequence, and fixing the attribute clears
     the note
9. **Export:** a decided entity is exported with the `spec_draft` moment;
   the file is written and the entity is marked exported. The template spec
   carries the formulas the entity depends on.
10. **The palette, from every view:** it reaches that view's own action (with
    its effect checked) and the global ones (the shell, W4's AI log, W6's
    snapshot).
11. **An external edit** of an entity file shows on the Column and the
    Bench, and clears the undo history.
12. **The real gateway path (`CARBON_AI=replay`):** the Bench's `tab`
    suggestion and `?` critique, then a spread from the Column cell, all
    through `ClaudeAiGateway` with W4's and W5's builders. Both requests are
    readable in the AI log, and the budget action is in the palette.

## 6. The visual pass, and the screens

What I unified across the views, against VISUAL.md:

- **Empty states:** one kit class, `.ui-empty`: `--text-2` at body size, with
  keys drawn as keys. Every view uses it, and each says what's missing and
  the one key that fixes it. Taste ("No judgements yet. `5` to spread.") and
  Spread (the key wasn't styled as a key) changed. `--text-3` is now used
  only for de-emphasised data, as §2 asks.
- **Shape:**
  - Control radii use `--radius-control`: the Spread moves and choices, Bench
    chips, and the paused AI status.
  - The Codex and Export checkboxes are the same size.
- **Focus:** every focusable element shows `--ring`. The Numbers intent
  points (SVG) didn't show keyboard focus; they now turn accent, like
  grabbing one. Two containers take focus only to hand keys back from tabs,
  and they say so in a comment.
- **Bench consequences:** the value is right-aligned and the label truncates.
  A list constant overflowed the Bench horizontally before.
- **Off-curve notes** name the entity and the curve: "Reef Plate is far off
  defense-budget: 22, intent 15 ± 3.75". Before, they read "defense-budget
  22 is far off its curve".
- **No raw hex values** anywhere outside the tokens; I checked with grep.

`docs/screens/`:

- **The seven views:** `column.png`, `climate.png`, `codex.png`,
  `numbers.png`, `spread.png`, `taste.png` and `export.png`.
- **The rest:** `bench.png` (the panel, with an inline suggestion, `ai`
  markers and route steps) and `palette.png`. These all come from the new
  `e2e/screens.spec.ts`.
- **The AI log:** `ai-log.png` is `ai.spec.ts`'s, on the real gateway path,
  with real usage and costs. The fake AI's is all zeros.
- **Package screenshots:** every one was regenerated from the merged app.
- **Removed:** the eight `foundation-<view>.png` placeholder screens. The
  smoke test's view shots are now test artifacts only. `foundation-ui-kit.png`
  stays; it is the kit gallery.

## 7. Changes to shared contracts

All are additive except where noted.

| File | Change |
|---|---|
| `src/renderer/state/ui.ts` | **One hand-off:** `UiState.spot` and `startSpreadAt(spot)`. W1's `spreadRequest`/`startSpread` and W2's `spreadSpot` are removed (they were never on the main branch) |
| `src/renderer/state/world.ts` | `whenRev(rev)` |
| `src/renderer/state/notes.ts` | The open notes are memoised per state (behaviour unchanged) |
| `src/renderer/actions.ts` | `RANK`, `ordered()` and `duplicateKeys()`. `registerActions(actions, { rank, within })` and `useActions(actions, enabled, { rank, within })`. Layers keep their place when their actions change |
| `src/core/commands/patch.ts` | Copy-on-write per patch (behaviour unchanged, property-tested) |
| `src/core/placement/resolve.ts` | `samePlacingInputs` and `resolveFresh`, plus reuse across worlds |
| `src/core/numbers/consequences.ts` | New: `entityConsequences` |
| `src/core/checks/numbers.ts` | `createNumbersAdapter` (`noNumbers` kept for tests) |
| `src/core/checks/placement.ts` | `resolvedPlaces` replaces `localPlacement`/`fromResolver` (both removed) |
| `src/core/prompts/spec.ts` | `specNumbers` |
| `src/core/prompts/registry.ts` | `PACKAGE_BUILDERS` holds W5's builders; the fallbacks are removed |
| `src/main/module-def.ts` | New: the module types and `defineMainModule` (re-exported from `modules.ts`) |
| `src/main/store/disk-state.ts` | `DiskState.writes` |
| `src/renderer/shell/StatusLine.tsx` | `data-testid="status-notes"` with `data-count` |
| `e2e/harness.ts` | `screenshot(name, { docs?, element? })` |

## 8. Decisions

1. **The hand-off is `ui.spot`**, W5's name. The Spread view owns it, it
   needs no sequence number (the view clears it once adopted), and it's the
   one the Spread view already read.
2. **One critique path:**
   - **The engine** is W1's `benchAi.critique`: per-channel request slots,
     the busy state, and quiet failures for critiques you didn't ask for.
   - **The triggers** are W4's (they see edits made anywhere, and state
     changes from the Codex too), rewritten as `ai/finish.ts`. The baseline
     is the entity's `updated` stamp, taken when it gains focus and after
     each critique.
   - **"Finishing an edit"** means focus moved to another entity, the Bench
     lost focus or closed, or `ctrl+s` was pressed, after a change.
   - A state change critiques the entity, and leaving afterwards doesn't send
     it again. An entity you didn't change is never sent.
   - `?` and `ctrl+s` are the Bench's keys.
3. **Live consequences are numbers and true/false.** A list or entity
   constant is a query, not a consequence of the entity's numbers. Functions
   apply only when they take exactly this entity.
4. **Check notes for formula errors** have ids from the definition and the
   message, not the line. Inserting a line above a broken formula no longer
   resets its dismissal (W3's gap).
5. **Checks run after a burst** of patches (120 ms quiet, 500 ms at most).
   Notes still follow every change, a moment later, and a burst of commands
   doesn't pay for a check run between each.
6. **The Bench sits below the views in key rank**, except while focus is in
   it (§4). Views mean their own `d`, `ctrl+enter` and `ctrl+s`.
7. **A numbered series isn't a near-duplicate.** Exact duplicates are still
   flagged.
8. **The AI log screenshot** is the replay-mode one (real usage and costs).

## 9. Tests and measurements

- **Unit and property tests (Vitest):** **502** tests in 45 files, all
  passing. About 55 of them are fast-check property tests, across commands,
  patches, the resolver (including the new reuse property), numbers, checks,
  the packer, prompts, spreads, the Column, the Codex, Climate, the palette,
  the store and the watcher.
- **Coverage of `src/core`:** 97.5% lines, 96.7% functions, 95.9%
  statements, 88.0% branches.
- **End to end (Playwright `_electron`):** **90** tests in 10 specs, all
  passing, 20 of them `@smoke`.
  - Per spec: ai 8, column 23, integration 12, numbers 7, platform 7,
    screens 1, smoke 6, spreads 14, ui-kit 1, world 11.
  - The full suite passed three runs in a row on the final code (and three
    before the visual pass), about 1.5 minutes each under xvfb.
- **`npm run check`:** passes (lint, prettier, `tsc`, unit tests, the build
  and the 20 smoke tests).
- **Performance (SYSTEM §9), measured on the 2,000-entity stress world with
  every package merged:**

  | Measure | Result | Budget | Before the fixes |
  |---|---|---|---|
  | Column panning | 60.4 fps | 50 fps | 6 fps |
  | Round trip, an edit the Column doesn't draw | 6–8 ms median | 16 ms | |
  | Round trip, a rename the Column redraws | 12.5–13 ms median | 16 ms | 31 ms, after the first fixes |
  | Codex `shift+g` over 2,000 rows | under 2 s | 2 s | |

## 10. Known gaps, across all packages

Sizes are rough: **S** is under half a day, **M** is one or two days, and
**L** is more.

| Gap | Package | Size |
|---|---|---|
| **No real API run yet.** Live evals (`npm run eval`), `npm run smoke:ai` and recorded fixtures (`npm run eval -- --record`) need the key on your machine. Recall, precision and diversity against Haiku 5.5 are unmeasured. W4 estimates $0.01–0.03 | W4, W5 | S (on your machine) |
| **The check runner is still O(n) per change:** about 16 ms on 2,000 entities in Node. It's scheduled after bursts, so it stays off the command path. Making the placement-dependent passes incremental, or moving checks to a Web Worker fed by patches, would remove it | W6 | M |
| **A rename on 2,000 entities is 12.5–13 ms against the 16 ms budget.** The Column model rebuild is about 4 ms, plus W6's durable writes. There isn't much headroom; incremental cell indexing would add it | W1 | M |
| **Undoing an export** reverts the states but leaves `exports/<file>.md` | W6 | M |
| **Text typed in a Bench input but not committed** isn't part of external-edit conflict detection | W6, W1 | M |
| **Spread triage waits for the stream to end**, and changing the axes applies to the next run | W5 | M |
| **The fake gateway's Ground and Cost candidates carry no fields**, so those keeps change only the record under the fake. The real builders and the property tests cover the field paths | W5 | S |
| **The system keyring** isn't read; the key comes from `ANTHROPIC_API_KEY` only | W4 | S |
| **The AI result cache and request texts** last for the session, by design. Only `ai.debug` persists full requests | W4 | — |
| **The Codex** doesn't remember sort or column widths, can't hide or reorder columns, and doesn't edit climate or route inline. The filter has no autocomplete | W2 | M |
| **Climate's arrow-key nudges** are one undo step each | W2 | S |
| **Numbers:** intent points move vertically only, with no adding or deleting a point; no autocomplete or go-to-definition in the editor | W3 | M |
| **Packaging on the real machine:** `hyprctl` against a real Hyprland, the desktop entry and the Wayland app id are tested only with fakes. Hyprland's rule syntax may differ by version. There's no app icon | W6 | S |
| **No migration exists yet** (format 1 is the first). The machinery is tested with synthetic migrations | W6 | — |
| **The Column:** chip names truncate heavily with all lanes and the Bench open at 1440 px; the scroll position is kept for the session only; overlapping bands draw on top of each other (no check flags them yet) | W1, W6 | S each |
| **The kit's `Input` remounts its `<input>` when a suggestion appears.** The Bench restores focus and the caret around it; the polish pass may prefer an `Input` that always renders its wrapper | W1, kit | S |
| **Empty states** now share one style, but not one position: centred in the Column and Spread, top-left elsewhere. VISUAL doesn't say which; the polish phase may want one | all | S |
| **Pure Column and Bench logic** (`layout`, `scale`, `value`) lives in renderer folders, so the core coverage threshold doesn't apply to it. Hardening may move it to `src/core/column/` | W1 | S |
