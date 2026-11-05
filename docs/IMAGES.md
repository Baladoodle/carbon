# Carbon: images and icons

Concept art for any entity, and 16×16 item icons in Infinite's style, generated
with OpenAI image models and Genforge's pixel filters, which are ported into
carbon. This document is the contract for the image work. `PRODUCT.md`,
`EXPERIENCE.md`, `SYSTEM.md` and `VISUAL.md` still apply; where they say
"visuals are out of scope", this document supersedes them.

---

## 1. What it adds

| Image | For | Size | Where it shows |
|---|---|---|---|
| **Concept** | any entity | 1024×1024 or 1536×1024 | the Bench header, the Codex thumbnail column, and **filling its Climate panel** (biomes: the image covers the panel, with the name on a soft scrim) |
| **Icon** | items, plus any kind the schema marks `icon: true` | 16×16, with a 4× preview | Column chips, the Codex, the Bench, export specs |

An icon is made in one of two ways:

1. **Generated:** an OpenAI call using Genforge's item prompt conventions, then
   the `item` pixel filter.
2. **Filtered from the entity's concept image:** the `item` filter only, with
   **no API call**.

**Deliberate, always.** Nothing generates on its own: every image comes from a
keypress, a button or a confirmed batch. The cost is shown before the call and
logged after it.

**Low quality by default**, for concept art and icons alike. Medium and high
are a per-call choice, never a default.

**The model defaults to `gpt-image-2.6-flare`** (Images 2.6; Genforge used
2.5-flare). `gpt-image-2.6-sunburst` is selectable in settings and per call.
Both are available on the API project used for development.

## 2. The ported Genforge pieces (`src/core/pixel/`)

These are ported from Infinite's `tools/genforge`, with its provenance
recorded:

- **Filters:** the presets `item`, `sprite`, `texture` and `none`, from
  `genforge/filters/{__init__,items,topology}.py`. They are pure TypeScript
  over RGBA buffers (`{ width, height, data: Uint8ClampedArray }`), with no
  native modules. PNG encoding and decoding use a pure-JS library in main.
- **Parity tests:** for fixture source images (committed under
  `fixtures/pixel/`), the reference outputs are produced by Infinite's
  Genforge (`python tools/genforge filter … --preset <p>`) and committed. The
  port matches them **exactly** for `item` at 16×16, or within a documented
  per-preset tolerance where floating-point order makes exactness impossible.
  A script regenerates the references from a Genforge checkout.
- **`UPSTREAM.json`** in `src/core/pixel/` records the source files and their
  sha256 values, as Genforge does.
- **Run rules from Genforge:**
  - **No automatic retry of a paid call whose outcome is unknown.** A pending
    or indeterminate attempt may already have been charged.
  - Every run keeps its plan, its inputs, the provider source image, a receipt
    (attempts, usage, request ids) and the output with provenance hashes.
  - Re-filtering a kept source is free.
- **Item prompt conventions:** the house style of Genforge's
  `prompts/items/*.txt` (subject, presentation, proportions, light, a
  transparent background, no text or border) becomes the icon prompt template.
  Concept art uses the world's **art direction** (§5).

## 2a. Icon sheets (batch = one image, then crop)

The user's own testing: one 10×10 generation gives about 100 good sprites
about 99% of the time. Batch icon generation therefore **generates one sheet
and crops it**. It doesn't make one call per icon.

1. **Layout:** N items (up to 100 per sheet; more makes several sheets) go in
   a `cols × rows` grid (default 10×10, or smaller for small N) on one canvas.
   Use the largest square size the model supports, verified, so each cell is as
   large as possible. Cells are equal, with gutters.
2. **Guide:** a guide image is drawn as a reference, as Genforge's tile
   workflow does: faint cell boxes on a flat background. It goes with the
   prompt, so the model keeps to the grid.
3. **Prompt:** the item house style once, then each cell by position
   ("row 1, col 1: a chunky iron pickaxe …"), with every item centred in its
   cell, no item crossing a cell edge, no text or labels, and one flat
   background colour, or transparent where supported.
4. **Crop** (pure, in `src/core/pixel/sheet.ts`):
   - cut each cell by the grid, with a margin
   - find the sprite inside it by background segmentation (the flat colour, or
     alpha), take its bounding box and pad it to square
   - **flag** a cell when it's empty, when the sprite touches the cell edge
     (it may bleed into a neighbour), when it has several large disconnected
     parts, or when it's the near-uniform background
5. **Filter:** each crop goes through the `item` preset to 16×16, the same as
   single icons.
6. **Review:** the sheet, each cell's crop and result, and its flags. Accept or
   reject per cell. Accepted cells become icons (`origin.by: 'sheet'`, with
   the sheet image id and cell index). The sheet is kept as an image too (kind
   `sheet`) so it can be re-cropped for free. "Regenerate flagged" makes a new,
   smaller sheet of just those items.
7. **Run rules:** a sheet is one paid call, with its plan, guide, prompt,
   receipt and provenance kept. No automatic retry of an unknown outcome.

## 3. Storage

Image metadata is part of `World`, so choosing and removing images is an
ordinary undoable command. Pixels are files beside it.

```
<world>/images/<entity-id>/<image-id>.png         the image (icons: the 16×16 output)
<world>/images/<entity-id>/<image-id>.src.png     the provider's source image (generated images only)
<world>/images/<entity-id>/<image-id>.json        metadata, as below; also mirrored in World
```

```ts
interface ImageMeta {
  id: string;                     // ulid-like, sortable
  entity: EntityId;
  kind: 'concept' | 'icon' | 'sheet';
  origin:
    | { by: 'openai'; model: string; quality: string; size: string; prompt: string; requestId?: string }
    | { by: 'filter'; from: string /* image id */; preset: string; settings?: unknown }
    | { by: 'sheet'; sheet: string /* sheet image id */; cell: number; preset: string };
  usage?: { inputTokens?: number; outputTokens?: number; images: number };
  costUsd?: number;
  created: string;
  hashes: { output: string; source?: string };
}
// World: images: Record<EntityId, { concept?: string; icon?: string; all: ImageMeta[] }>
```

- **Commands:** `image.add` (after main has written the files atomically),
  `image.select`, `image.unselect`, `image.remove`.
- **Undo:** removing or unselecting keeps the files. Files are purged only by
  an explicit "Delete image files" action, with a confirm.
- **Git:** images are committed with the world. `.gitattributes` marks `*.png`
  as binary.

## 4. Providers and the gateway

- **`src/main/images/`** holds the `ImageProvider` interface and an OpenAI
  implementation using the official `openai` npm SDK.
  - Generate, and edit with references (an icon from a concept, as a
    reference).
  - The model and quality are configurable. The defaults are
    `gpt-image-2.6-flare` and `low`. Verify the pricing against OpenAI's
    documentation, and record the date in the settings defaults.
  - Use a transparent background for icons where the model supports it.
- **The key** comes from the system keyring (service `carbon`, account
  `openai-api-key`), then `OPENAI_API_KEY`. It is never logged and never
  written.
- **Budget:** a separate OpenAI spend meter and session budget, shown next to
  Claude's in the status line. Costs are computed from the response's usage
  where the API reports it, with a pricing table in settings. The budget
  pauses image generation exactly as Claude's pauses AI.
- **The AI log** shows image calls too, with provider, model, size, quality,
  usage, cost, latency and a thumbnail.
- **The prompt is written by Claude** (a new moment, `image_prompt`, on
  Haiku). It is built from the entity, its relations and place, and the art
  direction. You can see and edit it before anything is spent, and you can
  also write it yourself.
- **Tests never call OpenAI.** They use fixtures, including streaming or
  partial results if used, errors, timeouts and content-policy refusals.

## 5. Art direction

`world.settings.art` holds:

- `direction`: a free text paragraph, such as "painterly, muted earth tones,
  soft rim light, readable silhouettes".
- per-kind notes.

It's edited in Taste, as its own small section, and it goes into every
`image_prompt` request. Icons use the fixed Genforge item conventions plus the
direction's palette words.

## 6. Experience

| Where | What |
|---|---|
| **Bench** | An image strip under the title: the selected concept image (click to enlarge), the icon at 1× and 4×, and earlier versions as small thumbnails. Actions (keys in the palette and tooltips): **Concept** generates, **Icon** generates, **Icon from concept** (free), **Choose**, **Remove**. Before a paid call: the editable prompt, the model, quality and size, the estimated cost, `enter` to run, `esc` to cancel |
| **Batch** | Select entities in the Codex, or a Column lane or cell, and run "Generate icons (N)" or "Generate concepts (N)" from the palette. **Icons batch as sheets (§2a): one call for up to 100 icons.** Concepts batch one call each. A dialog lists the items and their per-item prompt lines, the model and quality, the call count and the estimated total; nothing runs until you confirm. Then a sheet review: the generated sheet with its grid, each cell's crop and 16×16 result, cell flags, accept or reject per cell, and "regenerate flagged" (a smaller sheet). Entities that already have an icon are skipped unless "replace" is ticked |
| **Column** | Item chips show their icon (16×16, `image-rendering: pixelated`) before the name |
| **Codex** | An image column: the icon, or a concept thumbnail |
| **Climate** | A biome panel with a concept image is filled by it (cover, cropped to the panel), with the name and signature on a soft scrim so the text stays readable. An empty panel shows a quiet generate affordance on hover or selection, and the panel's menu has **Generate concept** |
| **Export** | Specs list each entity's icon and concept paths, and copy them into `exports/<spec>/images/` so Claude Code can move icons into Infinite's `assets/items/` |

**In place, everywhere.** The image actions live where the entity is drawn:

- the Climate panel: its menu, plus a button on hover or selection
- the Column chip menu
- the Codex row menu and bulk bar
- the Bench `…` menu and image strip
- the palette

One key works on whatever is selected in any view: suggested `ctrl+g` for
concept and `ctrl+shift+g` for icon. Check them against the duplicate-key test.

Nothing sends a request until the prompt confirmation (`enter`). It shows the
editable prompt, the model, the quality and the estimated cost.

`VISUAL.md` applies:

- generated images carry the `--ai` marker only as a hairline, never a badge
- thumbnails have 6px radius and hairline borders
- icons are always pixelated, never smoothed
- no captions under images; the metadata is in tooltips

## 7. The critique fix (with this work, see SYSTEM.md §8a)

AI-written text was critiqued by the AI. Three changes fix it:

1. **One quality bar.** The criteria in `src/core/prompts/quality.ts` (just a
   number, weak identity, duplicate, rule clash, contradicts relation) are the
   critic's rubric **and** a constraint in every generating prompt (suggest,
   fill, spread). The writer is held to the bar the critic judges by.
2. **Only your edits trigger critique.** A "finished edit" critique runs only
   when a field you edited changed since the baseline. Accepting AI proposals
   alone doesn't trigger it. A state change and `?` still critique.
3. **The critic knows the provenance.** It's told which fields the AI wrote. A
   note on an AI-written field offers **Rewrite**, which runs `suggest_one`
   for that field with the note as guidance, instead of leaving a dead end.

`npm run eval` gains a **self-consistency** metric: fill then critique on the
fixture worlds. Notes on just-filled fields must stay at or below 10%.
