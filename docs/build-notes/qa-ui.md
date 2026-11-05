# Build notes: `qa-ui` (the UI backlog, the walk-through, install, the guide)

Branch `claude/blissful-einstein-8u27ty-qa-ui`, from
`claude/blissful-einstein-8u27ty` at `592c80e`, with qa-core's work
(`b057f09`) merged in before the final runs. Scope: the UI, the docs and the
install experience. API spend: **$0.00**: fake gateway and fixtures only.

Every fix below began as a test that failed on the old code. The one
exception is §1.4, a race no e2e test can force; it is covered by unit tests
of the draft's rules instead. No test was skipped, weakened or deleted.

- **The UI backlog:** §1
- **The acceptance walk-through:** §2
- **Install:** §3
- **The guide and the key table:** §4
- **Outside my scope, for qa-core or later:** §5
- **Tests and the full runs:** §6

---

## 1. The UI backlog

### 1.1 The Codex selection survives filtering

**Decision:** keep the selection, and have bulk actions reach only the
selected rows on screen.

- **Why not narrow the selection to the visible rows?** You filter by
  typing, one character at a time. `state:d` matches nothing on its way to
  `state:decided`, so narrowing would wipe the selection at the first
  keystroke.
- **What the bar shows:** the count it acts on, plus `N hidden` in
  `--text-3` (its tooltip: "Selected, but not shown: bulk actions skip
  them").
- **What reaches the hidden rows:** nothing. `s`, `d` and `space` act on the
  visible part. When nothing selected is visible, they act on the cursor
  row, as with no selection.
- **What still applies to all of it:** clearing the filter brings the hidden
  rows back, still selected, and `escape` clears the whole selection.
- **Code:** `visibleSelection` (pure, `codex/columns.ts`), unit-tested.
- **e2e:** `world.spec › codex bulk actions reach only the selected rows the
  filter shows, and say how many it hides`.

### 1.2 The kit's `Tabs` and focus

- **Fix:** a pointer click on any tab, the current one included, no longer
  leaves focus in the strip. `focusAfterClick` names the surface the tabs
  switch (the Climate plane, the Codex table). Without it, the strip lets go
  of focus and the app's keys apply again.
- **Unchanged:** the keyboard still walks the strip.
- **Timing:** focus is handed back at once on pointer-up, and only while
  focus is still in the strip. That is review-a's rule from defect 14.
- **Workarounds removed:** the `display: contents` wrappers in Climate and
  the Codex.
- **e2e:** `ui-kit.spec › a click on a tab, even the current one, leaves no
  focus in the strip`. It covers the current tab, another tab, and the
  arrows after a keyboard focus.
- **Still green:** review-a's `world.spec` tests for this.

### 1.3 Draft conflicts for range, climate, route and attribute fields

- **The move:** `useTypedDraft` and the inline prompt now live in
  `bench/draft.tsx`.
- **Who uses them now:**
  - `NumberPair`, for range and climate fields. A conflict shows the pair's
    outside value (`2 … 7`).
  - `StepRow`, for a route step's text.
  - `AttributeRow`.
- **What hasn't changed:** leaving the field decides nothing; Keep mine
  commits yours; Use theirs takes theirs.
- **In a pair:** an outside change to the end you aren't typing in merges
  silently (it was never in your draft).
- **e2e:** `column.spec › range, climate, route and attribute drafts ask too,
  when an outside edit lands`.
  - The item in that test is written from outside, because an item carbon
    has just written sits inside the store's 15 s settle window. There, an
    outside edit goes to the whole-file conflict dialog instead, which is
    the right behaviour.

### 1.4 Also fixed: qa-core's open Bench item

**The defect** (qa-core §9; it was the cause of their one flaky smoke run):
- A draft reset only when the stored value *differed* from the last one
  rendered.
- A commit and its undo landing in one render leave the stored value as it
  was. The undone text then stayed as a dirty draft, and leaving the field
  wrote it back, undoing the undo.

**The fix:**
- The draft's rules are now pure transitions in `bench/draft-state.ts`.
- Once a commit has landed, the draft follows the store until the next
  keystroke (`landed(committed)`). Every draft control calls it, but only
  when its commit succeeded: a refused value stays as typed, so you can fix
  it.
- If you typed on past the committed text, the draft stays as you left it.

**Tests:**
- `bench/draft-state.test.ts` steps the same-render sequence exactly.
- No e2e test can force the two patches into one render, because React may
  render between the two IPC messages. I tried, and checked that the attempt
  passed on the old code. The e2e kept from that attempt (`column.spec › a
  commit undone at once resets the field…`) covers the common path and says
  so.

## 2. The acceptance walk-through

`e2e/acceptance.spec.ts` is one test that runs the whole flow below, through
keys and clicks only (no dispatched commands). It starts from an empty world
in the 1440×900 window and writes 23 screenshots to `test-results/screens/`.
It takes about 11 s.

1. **Bands.**
   - `n` on the empty Column makes Surface.
   - `k` then `n` writes Low Sky above it, and again for High Drift, whose top
     is set to `∞`.
   - `j` (×6) then `n` writes Hollows, and again for Deep, whose bottom is set
     to `-inf`.
   - The Deep edit is undone, then redone.
2. **Biomes, then what lives in them.**
   - Climate: two biomes in Surface, nudged with the arrows; one in Hollows.
   - Column cells: `n` makes a material and a creature.
   - Codex: a structure, named inline on its tab.
   - The Bench relates them: lives in, drops, found in, in biome.
   - On the Column, the structure is placed through its biome.
3. **Progression.**
   - A capability with a verb, and an item with subkind, change and
     trade-off.
   - A route step that needs the capability.
   - A feat that unlocks the capability.
4. **Numbers.**
   - `v` makes `k = 100`, then three formulas are typed in (values checked).
   - `a` adds the attribute `lift` on items.
   - `c` makes a curve over bands, with items as dots.
   - The item's lift, set on the Bench, becomes a dot.
   - A double-click starts the intent curve; `+` and `shift+↑` edit it.
5. **A spread from a Column cell** (Low Sky · items).
   - Triage: one keep, three kills, `u` and a kill again.
   - Taste counts the reasons. Learn proposes patterns, and one is promoted.
6. **The lifecycle.**
   - The item goes idea → shaped (the menu).
   - `d` with a Why is refused while Moment is empty, and the Bench says so
     under the field. Once Moment is filled, `d` decides it.
   - That is undone and redone.
   - The capability goes idea → decided with `d` in one step.
7. **Export.**
   - The Low Sky band chosen gives 2 entities.
   - The AI draft (`ctrl+enter`), then "Use the spec template" (what a world
     without a key gets).
   - Edited, then written with `ctrl+s`. The file holds the route, and both
     entities are exported.
8. **Undo and redo** throughout: the band edge, the spread (`u`), the
   decision, and the export (the file and the marking go and come back
   together). An exported entity edited later is flagged.

### What it found, and what I did

Fixed, each with a test that failed first:

| # | Step | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | 1 | **The identity line was invisible on a new entity.** It's a borderless, transparent input with no label, and empty it showed nothing, while the critique note asked for "a sharper one-line identity" | Placeholder "Identity" on the bare identity line only. It's that control's only label, so the text rule allows it. The kit hides it under a ghost suggestion | acceptance |
| 2 | 1 | **Undo toasts named fields by their keys:** "Undid Edit y_bottom of Deep" | Undo labels use the field's label: "Edit bottom of Deep", "Set lift of …" | acceptance |
| 3 | 2 | **Climate's `n` didn't put the new biome's name in focus**, so typing the name ran Climate's keys | `requestFieldFocus(id, 'name', true)`, as on the Column | acceptance |
| 4 | 2 | **A fast "`n`, then the name" lost its first letters** ("lowmoss Caverns"). Focus can only move once the create command has round-tripped and the Bench has rendered, and keys in that gap went to the view's keymap. This was on the Column too, just less often | `bench/typeahead.ts`: from `n` until the name takes focus (or 1.5 s), printable keys are held at capture and then typed into the field | `column.spec`, `world.spec › letters typed straight after n land in the new …'s name`. Both fail on the old code every time, because `n` and the letters are dispatched in one synchronous burst |
| 5 | 2 | **Margin notes ran into each other.** Their stack spaced them by an area estimate (`ceil(width / 132)`), which undercounts once words wrap | `wrappedLines` (pure, `core/column/layout.ts`) counts lines as the browser wraps them, at the real text width (130 px) | unit and property tests; acceptance asserts no two notes overlap |
| 6 | 2 | **The Codex filter was an unlabeled blank bar** | An example placeholder, shown only while the filter is empty: `Filter: state:idea band:"Low Sky" lane:items`. Same reason polish kept the formula editor's | acceptance |
| 7 | 4 | **`v` then a name then `enter` left the variable at 0**: only `tab` went on to the value | For a variable just made, `enter` on its name goes on to its value | acceptance |
| 8 | 6 | **"Needed to be decided" stayed under a field after you filled it** | The message shows only while the field is still missing for that state | acceptance |

Recorded, not changed:

- **In Taste, `d` dismisses the selected pattern**, not "decide the entity on
  the Bench". This is the documented rule: a view's key wins while you're in
  the view, unless focus is in the Bench. The walk-through decides from the
  Column, and the guide's key section says it.
- **Items kept from a Fill spread on an Items cell have no subkind**, so a
  check note asks for one. This is the fake gateway's candidates; whether real
  ones carry a subkind is unmeasured.
- **Four core text issues**, listed in §5.
- **Looks right:** the Climate plane, the spread field, the intent curve,
  edit-after-export (a decided glyph plus Export's dot) and the export
  template's content.
- **Speed:** no step was slow. The whole walk-through takes about 11 s,
  including the fake AI's streaming.

## 3. Install

### `npm run dist`

It builds `dist/linux-unpacked/` and `dist/carbon-0.1.0-x86_64.AppImage`
(135 MB). I launched both through Playwright against a fresh fake `$HOME`,
under Xvfb:

| Build | Cold start to the shell | Window | World |
|---|---|---|---|
| unpacked | 0.82 s | 1440×900 | `~/infinite-bible` created with `.git`, the empty state shown |
| AppImage (extract-and-run: the container has no FUSE) | 2.7 s | 1440×900 | the same |

**A finding:** the AppImage's runtime loads `libfuse.so.2`, and Arch has it
only in the `fuse2` package, which isn't installed by default. An install that
picked the AppImage could hand you a `carbon` that doesn't start.

### `scripts/install-omarchy.sh`

**Changed:**
- **The default prefers `dist/linux-unpacked`.** It needs no FUSE and starts
  faster. The AppImage is used when there's no unpacked build, or with
  `--appimage`.
- **An AppImage install warns** when `ldconfig -p` has no `libfuse.so.2`, and
  names both fixes: `sudo pacman -S fuse2`, or `--dir dist/linux-unpacked`.
- **`CARBON_DIST`** lets the tests aim the default choice.
- **Tests:** two new ones in `tests/install-omarchy.test.ts` (13 in all).

**Run for real** against the built `dist/`, in a fake `$HOME` with a fake
`hyprctl` (`version -j` gives `v0.53.1`):
- **`install --hypr`:**
  - It wrote the app (313 MB), the launcher, the desktop entry, the icon, the
    0.53 rule and one marked `source =` line in `hyprland.conf`.
  - The launcher started carbon (0.70 s to the shell).
  - With a carbon window reported, the launcher called `hyprctl dispatch
    focuswindow class:^(carbon)$` and started nothing.
- **Again:** everything unchanged, still one `source =` line.
- **`--uninstall`:** it removed all of it. The `hyprland.conf` kept exactly
  its own line, and worlds and settings were untouched.

**Still not tried on real hardware** (as platform noted): a running Hyprland,
`update-desktop-database`, the menu entry and icon, and the Wayland app id.

### From a fresh clone

The steps are in `GUIDE.md` §1: `git clone`, `npm ci`, `npm run dist`,
`scripts/install-omarchy.sh --hypr`, `carbon`. The README has the same as one
line.

## 4. The guide and the key table

**`docs/GUIDE.md`:**
- install, the world directory and git, and the key
- the first five minutes, with screenshots from `docs/screens/`
- every view and the Bench, a paragraph each
- the keys
- the AI's moments, cost and budget
- where data lives: snapshots, backups, quarantine and recovery
- the known limitations

**The limitations:**
- **Sources:** every build note's "open", "gaps" and "left for later"
  sections, checked against the code on this build. A subagent swept the notes
  first; I checked each item before it went in.
- **Dropped:** what qa-core fixed (inverted bands, dismissals carrying over to
  a reused id).

**The key table is generated from the action registry:**
- `actions.ts › keyRows()` returns every keyed action in the mounted layers
  (exposed read-only as `window.carbonKeyRows`).
- `e2e/keys.spec.ts` (`@smoke`, so it runs in `npm run check`):
  - It opens every view with an entity on the Bench, then the AI log, three
    suggestions, a spread with candidates and its kill prompt, and the Codex
    state dialog with its kill step.
  - It renders one table per section and compares the result with the block
    between the markers in `GUIDE.md`.
  - A hand edit of one label fails it with "the key table is out of date: run
    `npm run guide:keys`".
- `npm run guide:keys` rewrites the block.
- **Sections** come from an action's group, or its id's prefix for the hidden
  ones. An action no section claims fails the render, so a new view can't
  drop out silently.
- **Left out on purpose:** the two `*.undo-nudge` actions. Each is `ctrl+z`
  dropping a waiting nudge.

**README:** one screenshot (`column.png`), the one-line install, a pointer to
the guide, and the guide and `AI-FIRST-RUN.md` in the document table. The
"Phase 0" status line is gone, since it was out of date.

**Screens:** the canonical screens were regenerated on this build (polish's
command, VISUAL §8). Four changed: `column`, `column-stress`,
`bench-expanded` and `ai-log`, from the margin stacking and the empty
identity placeholder.

## 5. Outside my scope, for qa-core or later

These are text issues in `src/core`, met in the walk-through. They're in the
guide's limitations.

1. **Near-duplicate names are flagged across kinds**: biome "Salt Flats" and
   material "Salt Glass" (edit distance 0.2). Comparing within a kind, or
   across kinds only at a lower distance, would cut the noise
   (`core/checks/checks.ts`).
2. **A missing-field note names the state, not the entity**: "Idea needs
   subkind" (`requiredNotes`). "Moss Lung needs subkind (idea)" says which.
3. **An off-curve note names the curve by its id**, "far off curve-1".
   `CurveDeviation` could carry the curve's formula (`checks/numbers.ts`).
4. **The spec template's acceptance questions double their punctuation**:
   "Is the cost of using Kite Cloak felt: Heavy rain grounds you.?"
   (`core/export/spec.ts:181–182`).

**For the polish or a later phase:**
- The status line doesn't show the world directory, which EXPERIENCE §1
  lists. The guide says where it is instead.
- The `+ Step` button's accessible name is "Route", because the field's label
  points at it. That's right for a screen reader on an empty route, and odd
  once there are steps.

## 6. Tests and the full runs

The runs below are on the final branch, with qa-core merged in.

- **Unit and property tests:** 717 (qa-core's) → **728**, plus 1 skipped (the
  opt-in write benchmark).
- **e2e:** 112 → **120**:
  - `acceptance.spec`
  - `keys.spec` (`@smoke`)
  - `ui-kit.spec › tabs`
  - `world.spec`: the bulk selection and the Climate type-ahead
  - `column.spec`: the four draft-conflict kinds, the Column type-ahead and
    the immediate undo

- **`npm run check`, twice:** green both times. That covers lint, prettier,
  `tsc`, 728 unit and property tests, and 22 smoke tests (the key table's
  among them).
- **The full `npm run test:e2e`, twice:** 120 of 120 both times.
  - Rename round trip: median 8.4 and 12.1 ms (budget 16).
  - Identity round trip: median 5.6 and 5.0 ms.
- **The acceptance walk-through alone:** green on every run while I built it,
  about 11 s each.
