# Carbon: visual design

Carbon has its own dark, clean, neutral-gray look. It borrows the craft of
shadcn/ui (precise components, hairline borders, calm surfaces, strong focus
states) and is not a copy of it. It's an internal tool that should still look
deliberate and a little striking. Plain is a failure, and so is decoration.

This document overrides `design/mockups.html` on everything visual. The
mockups are a layout reference only: their colours, captions and chips are
exactly what this document forbids.

---

## 1. The text rule

**Every piece of text must justify its existence.** Before adding one, ask:
*what would the user lose if it weren't there?* If the answer is "nothing" or
"it looks emptier", it doesn't go in.

**Forbidden:**

- page or view subtitles, taglines, and catchphrases about what a view is for
- headings that repeat what the rail, the window or the selection already says
- tags, chips or badges as decoration; a chip has to carry state the user acts on
- helper text that restates its label ("Name: the name of the entity")
- marketing-style empty states. An empty state says what's missing and the
  one key that fixes it ("No bands yet. `n` to add one."), or nothing at all
- keyboard hints scattered across screens; they belong in tooltips, the command
  palette and `?`
- status-line items that never change or that nobody acts on
- placeholder text that just repeats the label

**Allowed, and wanted:**

- the user's data: names, identities, fields, numbers
- labels where a control's meaning isn't obvious from its content or position
- errors and notes, written precisely and briefly
- counts and states that change what the user does next
- tooltips on icon-only controls (an icon without one needs to be universal)

When in doubt, show the data and remove the label.

## 2. Surfaces and colour

These are neutral grays with no blue cast. The ramp is fixed; components never
use raw hex values, only these tokens.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#141416` | the app background |
| `--surface-1` | `#19191c` | panels: rail, Bench, sidebars |
| `--surface-2` | `#1f1f23` | raised: cards, inputs, table rows on hover |
| `--surface-3` | `#26262b` | overlays: popovers, the palette, menus |
| `--line` | `#2a2a2f` | hairline borders (1px) |
| `--line-strong` | `#37373d` | borders of inputs and focused containers |
| `--text` | `#ececee` | primary text |
| `--text-2` | `#a3a3ab` | secondary text: metadata, labels |
| `--text-3` | `#6e6e78` | tertiary text: only for de-emphasised data such as units or inferred values |
| `--accent` | `#e8a54b` | ember: the single accent, for focus, selection, primary actions and the current position |
| `--accent-fg` | `#1a1205` | text on accent |

Semantic colours are muted, so they never fight the accent:

| Token | Value | Meaning |
|---|---|---|
| `--state-idea` | `#8b8b95` | idea (outline only) |
| `--state-shaped` | `#7da7d9` | shaped |
| `--state-decided` | `#e8a54b` | decided (the accent: decisions are the point) |
| `--state-exported` | `#7fbf8e` | exported |
| `--danger` | `#e5675e` | errors, destructive actions |
| `--warn` | `#d9b45a` | notes that need attention |
| `--ai` | `#b39ddb` | the AI's marker, suggestions and its log; nothing else |

**Climate endpoints:** `--climate-cold` `#6f9bd1`, `--climate-warm` `#e09a52`
and `--climate-wet` `#63b0aa`. They exist only for the Climate plane's
gradient (§6.4) and are never used at more than about 13% strength. Dry is a
dimming, not a colour.

**Depth tint:** band backgrounds on the Column get a very slight tint by height.
Deeper bands lean warm (toward `#1a1614`), higher bands lean cool (toward
`#14171a`), and Y 0 is pure `--bg`. The world's vertical character is felt
without reading anything.

## 3. Type

- **UI:** Inter, or Geist if it's bundled, at 13px base, with weights 400, 500
  and 600 only.
- **Mono:** Geist Mono or JetBrains Mono, for numbers, ids, formulas, Y values
  and costs. Always use tabular numerals.
- **Scale:**

  | Size | Use |
  |---|---|
  | 11px | Metadata |
  | 12px | Dense tables and the status line |
  | 13px | Body |
  | 15px | Bench entity names |
  | 20px | The only large text: the Bench title |

- Letter-spacing is slightly negative at 15px and above. No all-caps text,
  except single-word section labels in the Bench, which can be 11px, 500
  weight, `--text-3`, with 0.04em letter-spacing.

## 4. Shape, depth and motion

- **Grid:** 4px spacing; dense views use 8px row padding.
- **Radius:** 6px for controls, 8px for cards and panels, 10px for overlays.
- **Borders:** 1px hairlines carry the structure. Depth comes from borders plus
  shadow, not lighter fills:
  - Raised surfaces have a 1px inner top highlight
    (`inset 0 1px 0 rgb(255 255 255 / 0.04)`).
  - Overlays have `0 8px 24px rgb(0 0 0 / 0.45)` and a backdrop blur of 8px.
- **Focus:** a 2px `--accent` ring with a 2px `--bg` gap, always visible on
  keyboard focus. Carbon is keyboard-first, so focus is a primary visual state,
  not an afterthought.
- **Motion:**
  - 120ms ease-out for hover and press, 180ms for panels and overlays.
  - Spread candidates stream in with a 140ms fade-and-rise.
  - Nothing bounces, and nothing animates on its own.
  - `prefers-reduced-motion` turns motion off.

## 5. Components

Build carbon's own component kit in `src/renderer/ui/`. Unstyled Radix
primitives are allowed for accessibility; the shadcn component code is not
copied. Each component has a small set of variants:

| Component | Variants and behaviour |
|---|---|
| **Button** | primary (accent fill), secondary (`--surface-2` + hairline), ghost, destructive; sizes sm and md; icon buttons always have a tooltip |
| **Input, Textarea, Select, Combobox** (entity picker) | `--surface-2` with a `--line-strong` border; the focus ring on focus; an error state with the message underneath. **AI suggestion state:** the suggested text in `--ai` at 70% opacity, inline |
| **Popover, Menu, Tooltip, Dialog, Toast** | Overlay depth from §4 |
| **Tabs** | An underline indicator in `--accent`, not pills |
| **Table** (Codex) | Hairline row separators, sticky header, monospace numeric columns aligned right, an accent rule on the left of the selected row |
| **Command palette** | Centered and 560px wide, with blur behind it. Results grouped by type, each group label shown only when there's more than one group |
| **State glyph** | A small shape, not a word: idea is an outlined circle, shaped a half-filled circle, decided a filled circle, exported a filled circle with a check, graveyard a hollow dashed circle. The word appears only in tooltips and filters |

## 6. Making it look good, not plain

These are the signature details that give carbon its character:

1. **The Column is the hero.** A fine ruler runs down its left edge, with
   ticks on the symmetric log scale and mono labels only at decade boundaries.
   Band edges are draggable 1px lines that thicken on hover. The unwritten
   ends fade into a faint diagonal hatch. Y 0 is marked with a single accent
   tick and no label.
2. **Light, not paint.** Selection and the current position glow softly
   (`--accent` at 12%, blurred) instead of being filled with flat colour.
3. **The spread field.** Candidates sit on a faint dot grid. Near-duplicates
   are joined by hairlines. Kept candidates move to the spot with a short
   motion before they leave the field.
4. **The Climate plane.** A subtle two-axis gradient (cold to warm,
   horizontally; dry to wet, vertically) at very low contrast. Biome regions
   are glass panels: `--surface-2` at 70%, with blur and a hairline border.
   - The plane carries a graticule: hairlines at the quarters and a faint dot
     every tenth, so the climate reads as a measured space, not a blank box.
   - The pointer shows its climate: two hairlines and a mono reading
     (`0.62 × 0.58`, temperature then moisture). The selected region shows its
     own range in its bottom-right corner (`0.30–0.55 × 0.60–0.95`).
   - A region holds its name, its identity (two lines at most) and its
     signature: what lives there, one row per kind (`--text-3` kind word, then
     the entities with their state glyphs).
   - Climate no biome covers keeps a faint hatch, quieter than the Column's.
5. **Numbers that look like instruments.** Curves are drawn as 1.5px lines.
   Intent curves are dashed. Control points are 6px squares that turn accent
   when grabbed. Entity dots get a tooltip showing their value.
6. **The AI has one colour.** Anything the AI produced or proposed carries
   `--ai`, and only that. The user always knows what came from them and what
   came from Claude.
7. **The Bench is not a form.** An empty optional field is noise. The Bench
   shows a field when it has a value, when the entity's current or next state
   needs it (`core/bench/optional.ts`), or while it has a reason: focus, a
   proposal or three alternatives waiting in it, a refused state change that
   names it. Every other field waits behind one quiet `+ Field` ghost button at
   the end of the fields; it opens a menu of their names, and the palette has
   `Add field: <name>` for each. A field that has shown stays shown while the
   entity is on the Bench, so clearing one never makes it vanish under you; it
   collapses again the next time the entity comes to the Bench. The Why section
   follows the same rule.
8. **The current view on the rail** glows, and a 2px accent bar marks it on
   the rail's left edge.

## 7. Empty states

One component (`Empty` in `src/renderer/ui`) and one position everywhere:
**centred, both ways, in the region the missing content would fill**: the
Column's strip, the Climate plane, the Spread field, the Codex table body,
the Numbers curves area, a Taste column, the Export preview, the Bench, the
AI log. The style is `--text-2` at body size on one line, with the fixing key
drawn as a key cap. The sentence is "what's missing. `key` to fix it." A
region that is merely sparse (a list with a few rows) has no empty state.

## 8. Screenshots

`docs/screens/` holds only the canonical screens, made by
`e2e/screens.spec.ts` (and the AI log by `ai.spec.ts`) with
`UPDATE_SCREENS=1`, in the 1440×900 window at device scale factor 2: one per
view, the Bench collapsed (`bench.png`) and expanded (`bench-expanded.png`),
the palette, the AI log, a spread mid-stream and the 2,000-entity Column.
Every other spec's screenshot is a test artifact in `test-results/screens/`.

## 9. Removed from the earlier design

- "Colours follow the Omarchy theme." Carbon has one theme of its own.
- View headers with titles and chips. The rail shows where you are, and a view
  shows only its content and controls.
- The keyboard legends and explanatory captions in the mockups.
