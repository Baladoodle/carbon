# Build notes: `images-ui`

Branch `claude/blissful-einstein-8u27ty-images-ui`, from
`claude/blissful-einstein-8u27ty` at `0bf99a2`. Scope: the renderer half of
`docs/IMAGES.md` (§1, §6, and the review UI of §2a). API spend: **$0.00**. Every
test runs on the fake (`CARBON_IMAGES=fake`), and the screens use images-core's
recorded real images.

**Merged in before the final runs** (for the coordinator):

- `origin/claude/blissful-einstein-8u27ty` up to `f1d9c4c`, which brings the
  critique worker's work, the §2a sheets spec and the 2.5-flare default in the
  docs
- `origin/claude/blissful-einstein-8u27ty-images-core` up to `103ff10`

---

## 1. What's where

Everything shared lives in `src/renderer/images/`. Each view only calls into it.

| File | What |
|---|---|
| `model.ts` | Reads `world.images` and `settings.art`: `selected`, `versions`, `takesIcon`, `artOf`, `generated` |
| `client.ts` | Core's `ImageGateway` over the `images:*` IPC; status, log and progress stores; typed `image.*` commands; `useImageSrc` (one data-URL cache per `entity/id/variant`) |
| `store.ts` | Image UI state: the confirm, batch, lightbox and purge targets, and `pending` per `entity:kind`, which drives the shimmers |
| `actions.ts` | The one set of actions: `requestImage`, `requestBatch`, `iconFromConcept`, `chooseImage`, `removeImage`, `imageMenu()`, and `useImageActions()` (the keys and palette entries) |
| `Confirm.tsx` | The confirm step every paid single call goes through |
| `Batch.tsx`, `SheetReview.tsx` | The batch dialog: concepts one call each, icons as sheets with a per-cell review |
| `Overlays.tsx` | Mounts the overlays and keys once (from `shell/App.tsx`); the lightbox; the "Delete image files" confirm |
| `BenchImages.tsx` | The Bench's image strip and its `…` menu entries |
| `Thumb.tsx` | The thumbnail (6px radius, hairline, `--ai` hairline when generated, icons pixelated), the shimmer, and `describe()` for tooltips |
| `StatusPiece.tsx` | OpenAI's spend beside Claude's, the pause state and the image budget dialog |
| `LogRow.tsx` | An image call in the AI log, with its thumbnail |

**Kit:** `ui/ContextMenu.tsx` is a right-click menu over a whole surface. It
takes `itemsAt(target, point)` and draws the same entries and look as `Menu`.
`IconImage` was added to `ui/icons.tsx`.

## 2. Per surface

- **Climate (the flagship):**
  - A biome with a chosen concept is filled by it (`views/climate/RegionArt.tsx`):
    `background-size: cover`, under a soft scrim. The scrim is a gradient from
    `--bg` at 78% behind the name to 10% at the bottom, plus a light text
    shadow. The panel's hairline takes `--ai`, and selection still wins with
    the accent.
  - A panel being generated shimmers.
  - An empty panel shows a quiet image button on hover or selection
    (`climate-generate`). Right-click gives the panel's menu: Generate
    concept, Remove, Open on the Bench, and Spread in this climate.
  - The selected panel's range reading gets a small backing so it stays
    readable over art.
- **Bench:**
  - The strip sits under the title: the concept (click to open the lightbox),
    the icon at 4× and 1× (pixelated), and older versions at 28px (click one
    to choose it; right-click for Choose, Enlarge and Remove).
  - Quiet buttons: Concept, Icon (only for kinds that take icons) and From
    concept (only once there's a concept).
  - The `…` menu has Concept, Icon, Icon from concept, Choose (the three most
    recent other versions), Remove concept and Remove icon.
  - With no images, the strip is just the quiet buttons row.
- **Column:**
  - Chips with an icon draw it at 16×16 (`<image>`, `image-rendering:
    pixelated`) between the state glyph and the name.
  - Core layout change: `CellEntity` and `Glyph` carry `icon`, and
    `chipWidth` / `layoutCell` add `CHIP_ICON` (19px). `cellBase()` builds an
    entry. `reindex` rebuilds when `world.images` changes, and the cell cache
    compares `icon`, which was a real bug caught by e2e. Unit tests are in
    `column.test.ts`.
  - The chip menu is a right-click on the main strip and the Inbox.
  - The palette has "Generate icons/concepts in this cell/lane (N)", and the
    chip menu has the cell and lane batches.
- **Codex:**
  - An image column (34px) shows the icon (pixelated), or else a concept
    thumbnail.
  - Right-click a row for its image actions, plus the batch over the
    selection when the row is part of it.
  - The bulk bar has `Concepts…` and `Icons…`.
  - The Codex registers its own `ctrl+g` and `ctrl+shift+g`, so the key
    reaches only the selected rows the filter shows (qa-ui §1.1's rule).
- **Keys:** `ctrl+g` (concept) and `ctrl+shift+g` (icon) are shell-rank
  actions (`images.concept` and `images.icon`).
  - They act on the multi-selection as a batch, or else on the entity in
    focus.
  - Their palette labels name the target ("Generate concept: Glide",
    "Generate icons (3)").
  - `keys.spec` has an **Images (in every view)** section. A small
    `GUIDE_LABEL` map gives these rows target-neutral text in the guide.
  - The duplicate-key check is clean.
- **The confirm step:**
  - The prompt is written by `images:prompt` (the `image_prompt` moment)
    under a shimmer. It's shown in `--ai` until you type, and editable;
    you can also write your own if the moment fails.
  - Model: Images 2.6 flare by default, or sunburst.
  - Quality: whatever settings say, which is **low** by default.
  - Size: any of the concept sizes. Icons are fixed at 1024².
  - The estimate (`images:estimate`) and what's left in the budget.
  - `enter` (not `shift+enter`) runs, and `esc` cancels. A paused budget or
    an over-budget estimate disables the run and says why.
  - An unknown-outcome failure says the call may have been charged and isn't
    retried.
- **Batch:**
  - Concepts: Claude writes every prompt, each editable, with skip or
    replace, model, quality, size, the call count and the total. They run two
    at a time with progress, "Cancel the rest" and a result per row.
  - **Icons follow §2a:**
    1. The plan shows a line per item, and the count reads
       `1 call · N icons`. It's re-planned locally when replace, model or
       quality change, and edited lines survive the re-plan.
    2. The run is `images:sheetRun`.
    3. **The review**, as the coordinator's sheet message asked:
       - the sheet with its grid drawn over it (from the sheet's
         `SheetGrid`), and the cursor's cell outlined
       - each cell's crop beside its 16×16 result (pixelated), its item's
         name, and its flags in `--warn`
       - keyboard triage like a spread: arrows (or `h`/`l`) move, `k`
         accepts, `x` rejects, `a` accepts every unflagged cell; also the
         **Accept unflagged** button and a click per cell
       - unflagged cells start accepted
    4. Regenerate N makes a smaller sheet of the rejected cells; it's a
       deliberate button.
    5. Accept N calls `images:sheetAccept`, one undo step per sheet.
  - The plan shows the grid: `1 call · 4 icons · 2×2`.
- **Taste:** an **Art direction** panel under Rules holds the direction
  paragraph and per-kind notes (`+ Kind`). It commits on blur, `enter` or
  `ctrl+enter`; `esc` reverts. Each edit is one `art.set` undo step.
- **Status line:** `images $x / $y` in `--ai` beside Claude's spend.
  - Its tooltip has the month, model and quality.
  - It reads "Images paused: …" at the budget; a click opens the image budget
    dialog (`settings.images.budget`).
  - It's hidden while images are off and nothing was spent.
- **AI log:** image calls are merged into the list by time, under an
  `images` tab, with a 20px thumbnail, usage, cost and latency. Provider,
  model, size and quality are in the row tooltip. The totals add
  `OpenAI $x · n image calls`.
- **Export:** the preview shows each chosen entity's icon and concept, with
  the paths in tooltips.

## 3. Visual rules, as applied

- No captions or badges. All metadata goes in tooltips (`describe()`).
- Generated images get an `--ai` hairline (thumbs, panels, sheets). Filtered
  icons get a plain hairline.
- Icons are always `image-rendering: pixelated`: chips, Bench, Codex, cells,
  lightbox.
- Loading looks like a slow shimmer on the glass. It turns off under
  `prefers-reduced-motion`.
- One exception to "keys only in tooltips": the dialog buttons show `esc`
  and `enter` / `ctrl+enter` key caps. The brief asks for exactly that in the
  confirm step.

## 4. Tests

- **`e2e/images.spec.ts`**, 9 tests, all on the fake:
  1. A Climate panel's menu, then esc: nothing is sent. Then enter fills the
     panel, at low quality on flare.
  2. The Bench shows the concept of a biome in focus; the lightbox opens and
     esc closes it.
  3. `ctrl+shift+g` on a Column selection; the prompt, model and quality are
     edited; the chip icon is pixelated; and the Bench shows it at 1× and 4×.
  4. Bench Concept; Icon from concept (free: the log doesn't grow); Choose an
     earlier icon, then undo; Remove concept from the `…` menu, then undo.
  5. Codex image column, row menu, bulk `Icons…`; skip and replace; an edited
     line; one sheet call; reject a cell, regenerate it (a second call),
     accept; the icon's origin is `sheet`, and the kept sheet holds the
     edited line.
  6. Budget pause: the confirm step says so, enter sends nothing, and raising
     the budget from the status line resumes.
  7. Taste art direction and a kind note, then undo.
  8. The AI log's image rows with thumbnails, and the Export preview.
  9. Batch with `CARBON_IMAGES_DELAY_MS`: progress, cancel the rest, and only
     the finished items are in the world and the log.
- **Unit:** icon room on chips, and an icon change re-indexing the Column
  model.
- **Keys:** `keys.spec` passes, and the GUIDE table is regenerated
  (`npm run guide:keys`).
- **Full `npm run test:e2e`:**
  - Two runs in a row after the final merges (with the sheet review):
    **134 of 134**, both times. Two earlier full runs were green too.
  - A run just before them had one failure, in `acceptance.spec`: `x` in a
    spread showed no kill prompt. It passed 3 of 3 alone and in both later
    full runs, and nothing in this work touches spread keys. It's worth
    watching as a possible load flake.
- **Units:** 814 passed. Lint, prettier and `tsc` are clean.

## 5. Screens (`docs/screens/`, 2×)

- **New:** `bench-images.png`, `images-confirm.png`, `images-batch.png` and
  `images-sheet.png` (the fake's synthetic sheet in review).
- **Replaced:** `climate.png`, now Hollows with Glowmoss Caverns filled by
  images-core's recorded real sunburst concept.
- **Regenerated:** the rest, because the Codex image column, the Taste
  panel and the status line changed them.
- **The art (`e2e/art.ts`):**
  - images-core's recorded real calls (`fixtures/images/`) where they exist.
  - Elsewhere, deterministic painted stand-ins: Ash Vents' landscape, Vent
    Glass Visor's sprite, and the Spore Lantern's earlier versions.
  - Ash Vents next to the real Glowmoss shows the difference. One real
    low-quality Ash Vents concept (about $0.02) would finish the screen.
- `README.md` keeps `column.png` as its hero, so it didn't change.

## 6. Left for later

- **Re-crop of a kept sheet:** `images:sheetCrop` is wired in `client.ts`,
  but nothing calls it. Reopening a past sheet's review (from the Bench
  version list, say) is a small next step.
- **The default model:** `IMAGES.md` now names `gpt-image-2.5-flare`, but
  core's `IMAGE_MODELS` doesn't list it yet. The confirm step and the batch
  dialog read core's list and settings, so they'll follow once core adds it
  (its label is ready). The e2e tests that assert the 2.6-flare default will
  need that one-word change then.
- **Choose in the `…` menu:** it lists the three most recent other versions;
  the strip lists all of them.
- **Closing the batch dialog** with `esc` while it runs cancels the rest. It
  doesn't keep running in the background.
