# Build notes: `polish` (Phase 4)

Branch `claude/blissful-einstein-8u27ty-polish`, from
`claude/blissful-einstein-8u27ty` at `893eac2`, which didn't move during the
pass. The job was the first impression: a dark, clean gray look, every piece
of text earning its place, and no view that looks unfinished. I used every
view on the sample world and on an empty world through Playwright, at 1280×800,
1440×900 and 1920×1080, with the Bench open and closed.

Before-and-after pairs are in `docs/build-notes/polish/`.

---

## 1. The Bench is not a form

**Before:** every entity showed every field of its kind, plus Description,
Tags and Why. Most of them were empty, so the Bench read like a blank form.

**After:**

- **What shows.** A field shows when it has a value or when the entity's
  current or next state needs it. For example, an idea shows what *shaped*
  needs, and a shaped entity shows what *decided* needs, including Why. A
  graveyard entity shows what *idea* needs, so reviving it is one step.
  - The logic is pure and lives in `src/core/bench/optional.ts`, with unit
    tests in `optional.test.ts`.
- **A field also shows while it has a reason:**
  - it has focus
  - an AI proposal, or three alternatives, is waiting in it (so `ctrl+enter`
    fills reveal what they fill)
  - a focus request names it
  - a refused state change needs it. Pressing `d` on an idea shows every
    field *decided* needs, not just the first step's.
- **Everything else waits behind `+ Field`.** It's a quiet ghost button at the
  end of the fields, styled like `+ Step`, and it opens a menu of the hidden
  fields' names.
  - The palette has `Add field: <name>` for each hidden field.
  - Choosing one reveals the field and focuses it.
- **Sticky.** Once a field has shown, it stays while the entity is on the
  Bench, so clearing a field never makes it disappear under the cursor. The
  next time the entity comes to the Bench, empty fields collapse again.
- **Unchanged:** `tab` and `shift+tab` suggestions work on any field,
  including revealed ones (the suggest action keys off the focused field). The
  inline "Keep mine / Use theirs" prompt is untouched, and a field you're
  typing in is always shown. Attribute rows aren't collapsed: they already
  appear only when their `when` applies.
- **A kit change:** `Menu` gets an `onClosed` prop. A field focused from inside
  the open menu lost focus straight back to the menu's focus trap, so the
  reveal now runs once the menu has closed.
- **Nothing in focus:** the Bench used to be a blank 360px column. It now
  shows the shared empty state: "Nothing in focus. `ctrl+k` to find an
  entity."
- **The crumb** no longer repeats a biome's own name ("Biome · Hollows · Ash
  Vents" is now "Biome · Hollows").

Pair: `bench-before.png` and `bench-after.png`. The expanded state is
`docs/screens/bench-expanded.png`.

## 2. Climate feels alive (VISUAL §6.4)

- **Gradient:** a clearer two-axis gradient. Cold to warm runs across, and wet
  runs up. Three new tokens, `--climate-cold`, `--climate-warm` and
  `--climate-wet`, are mixed in at 9–13% and are also in `tokens.ts`. Dry is a
  dimming toward the bottom, so the four corners read differently with no
  labels.
- **Graticule:** hairlines at the quarters and a faint dot every tenth.
- **The pointer's climate:** two hairlines and a mono reading such as
  `0.62 × 0.58`. It's its own component with its own state, so pointer moves
  never re-render the view or touch the drag refs that review-a made robust.
- **The selected region** shows its range in its corner, for example
  `0.30–0.55 × 0.60–0.95`, while you move or resize it.
- **Glass regions:** 8px radius, a soft drop shadow and a top sheen. Each
  region holds its name, its identity (up to two lines) and its signature,
  laid out as one row per kind with each entity's state glyph.
- **Hatch:** the hatch over climate that no biome covers is quieter (7%, every
  9px instead of 14%, every 7px).
- **A bug fixed on the way:** the "No biomes yet. `n` to add one." empty state
  was split into three pieces across the plane.

Pair: `climate-before.png` and `climate-after.png`. `empty-before.png` shows
the split empty state.

## 3. Empty states: one style, one position

**Decision** (VISUAL §7): one `Empty` component, centred both ways in the
region the missing content would fill. The text is `--text-2`, body size, one
line, with the fixing key drawn as a key cap. A region that is merely sparse
gets no empty state.

**Applied to:** the Column, the Climate plane (both its empty states), the
Codex body, Numbers (curves and attributes), the Spread field, the Taste
patterns column, Export, the Bench and the AI log.

**New empty states:**

- **Export's preview pane** was blank. It now says "Nothing chosen. `space` on
  an entity to choose it.", or "No draft yet. `ctrl+enter` to draft the
  spec." (`export-none`). Pair: `export-before.png` and `export-after.png`.
- **The Codex's All tab** on an empty world rendered nothing. It now says "No
  entities yet. `1` to start on the Column."
- **The Bench** (§1).

## 4. The §6 signature details, checked

| Detail | State |
|---|---|
| Column ruler: log ticks, labels at decades, accent mark at Y 0 | Present. Minor ticks were nearly invisible (`--line-strong`, 3px); they're now `--text-3` at 55% and 4px long, with decade ticks at 8px |
| Selection glows, not flat fills | Present (the `--glow` token on chips, regions and the rail). The Column cursor's fill went from 7% to 5%, so its glow and stroke carry it |
| Spread field: dot grid, near-duplicate hairlines, kept candidates moving to the spot | All present (`spread-to-spot`, with a reduced-motion override) |
| Climate glass panels | Refined (§2) |
| Curves drawn like instruments | Present: 1.5px lines, dashed intent curves, 6px square control points that turn accent when grabbed or focused, value tooltips on dots |
| `--ai` only for AI | Checked by grep. It's used only for AI markers, proposals, suggestions, the AI log, AI status and spend, the Learn button and AI notes |

**Added:** the current view on the rail gets a 2px accent bar on the rail's
edge, alongside its glow (VISUAL §6.8).

## 5. The text-rule audit

I went through every string the renderer shows: JSX text, `label`,
`aria-label`, `placeholder`, `title` and tooltip `content` (about 700
candidates, extracted with a script). Changed:

| Where | Before | After | Why |
|---|---|---|---|
| Spread, the spot button with no spot | "Choose a spot" | "Spot", in `--text-3`, as an empty value | It was an instruction, and the field's empty state already says "`s` to choose a spot" |
| Export, the spec name input | no visible label | placeholder "Spec name" | A blank box at the top of the pane didn't say what it was |
| Export, the preview pane | blank | the empty states in §3 | Something was missing, and nothing said what |
| Codex, the All tab on an empty world | nothing | "No entities yet. `1` to start on the Column." | Same |
| Bench, nothing in focus | blank | "Nothing in focus. `ctrl+k` to find an entity." | Same |
| Bench crumb, on a biome | "Biome · Hollows · *its own name*" | "Biome · Hollows" | It repeated the title just below |
| Climate, empty plane | the sentence broken into three pieces | one line | A bug |
| Bench, empty optional fields | label plus an empty input, for every field | collapsed behind `+ Field` | §1 |

**Kept, with the reason:**

- The Taste column headings (Rules, Kill reasons, Patterns) tell three
  same-looking panels apart.
- The kill-reason digits are each reason's key, which is data you set.
- The Climate axis words (cold, warm, dry, wet) are the only labels the plane
  has.
- The AI log column heads, and the Numbers `min / max / default / set` heads,
  label table columns.
- The formula editor's and the dots query's example placeholders show syntax
  you can't guess, and only appear when the field is empty.
- "inferred" in the Bench crumb is a state: the placement was derived, not
  set.
- The kill note's placeholder "A few words" is a hint, not the label repeated.
- Export's "0 entities" count changes what you do next, and a test keys on it.
- The Spread detail's kind word is useful when a band-wide spot mixes kinds.

## 6. Motion and focus

- **Motion:** every transition and animation uses `--dur-hover` (120ms),
  `--dur-panel` (180ms) or `--dur-stream` (140ms), checked by grep. All three
  go to 0 under `prefers-reduced-motion`. The one `calc(… + 80ms)` animation
  (kept candidates) has its own reduced-motion override.
- **Focus:** I wrote an audit that focuses every visible, enabled focusable
  element in each view with keyboard modality, waits out the transition, and
  checks for the accent ring on the element or a near ancestor. No element
  failed. A plain Tab walk can't reach everything, because inside Bench
  inputs `tab` asks the AI for a suggestion; that's by design, and `alt+↑/↓`
  moves between fields.

## 7. Typography, alignment and fit

- I checked all seven views at 1280×800, 1440×900 and 1920×1080, with the
  Bench open and closed. A script flagged horizontal page scroll and leaf
  elements overflowing without clipping, and I looked at every shot.
- **One fix:** at 1280, Taste's kill-reason counts clipped at the column's
  right edge. The name now shrinks with an ellipsis, and the bar shrinks to
  12px.
- **Seen and left alone:**
  - At 1280 with the Bench open, the Numbers editor scrolls horizontally on
    the longest formula. It really overflows, and wrapping code would be
    worse.
  - The Codex table keeps its set column widths rather than stretching to the
    pane, so a resize means exactly what you dragged.

## 8. Tests

- **New e2e test** (`column.spec › the Bench › empty optional fields wait
  behind + Field; a revealed one takes tab suggestions`):
  - the empty slot and description are collapsed
  - the menu reveals Slot and focuses it, and `tab` puts a ghost suggestion
    in it
  - the palette's `Add field: Description` reveals and focuses that field
  - coming back to the entity collapses them again
- **New unit tests:** `src/core/bench/optional.test.ts`.
- **`screens.spec.ts`** now makes every canonical screen (§9), adding
  `bench-expanded`, `spread-streaming` and `column-stress`.
- **No test asserted on text I removed**, so no assertion changed. The `d`
  test (deciding an idea) failed on the first collapse because Moment was
  hidden. That was a real gap in the pattern, and the fix is the refused
  state change rule in §1, not a test edit.
- **Harness:** `screenshot()` copies to `docs/screens/` only with
  `docs: true`. `launchCarbon({ scale })` passes
  `--force-device-scale-factor`. `SCREEN_SCALE` is 2 under
  `UPDATE_SCREENS=1`, and 1 otherwise.
- **Final counts:**
  - `npm run check`: green (lint, format, types, 649 unit and property tests,
    20 smoke).
  - The full `npm run test:e2e`: 111 of 111, twice. That's 108 before, plus
    the Bench test and two screens tests.
  - `world.spec` and `column.spec` together: 49 of 49, three times.
  - Rename round trip: median 8.5, 9.1 and 10.6 ms (budget 16).

## 9. Screens

- **`docs/screens/` holds only the canonical screens** (VISUAL §8), in the
  1440×900 window at device scale factor 2 (2880×1800):
  - the seven views: `column`, `climate`, `codex`, `numbers`, `spread`,
    `taste` and `export`
  - `bench` (collapsed) and `bench-expanded`
  - `palette`, `ai-log` (the real gateway's replay, from `ai.spec.ts`),
    `spread-streaming` and `column-stress`
- **Regenerate them with:**
  `npm run build && UPDATE_SCREENS=1 xvfb-run -a -s "-screen 0 3200x2000x24" npx playwright test e2e/screens.spec.ts e2e/ai.spec.ts`.
  The display must be larger than the window at 2×.
- **Removed:** 27 package screenshots, `foundation-ui-kit.png` among them.
  Earlier build notes that name them now describe artifacts that live in
  `test-results/screens/` when those specs run.

## 10. Decisions, in short

1. Bench fields: show filled, needed-now-or-next, and in-use fields. The rest
   go behind `+ Field`, sticky while the entity is on the Bench.
2. Empty states: one component, centred in the region the content would fill.
3. Climate gets its own low-strength endpoint tokens rather than borrowing
   state colours.
4. The pointer's climate reading is data that helps you place a biome, so it
   passes the text rule. The selected region shows its range, and other
   regions don't.
5. Only canonical screens go in `docs/screens/`.

## 11. Left for later

- The Codex could stretch its last column to fill the pane, if that's
  preferred over exact widths.
- Attribute rows don't collapse. If kinds gain many attributes, they should
  follow the same rule.
- Not checked on the real machine: Inter and Geist Mono rendering at the real
  display's scale under Hyprland.
