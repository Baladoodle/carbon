# Build notes: pixel

Genforge's pixel filters are ported to pure TypeScript in `src/core/pixel/`.
They match the real Genforge **exactly**, for every preset:

- **135 committed references:** 0 differing pixels.
- **1,520 random fuzz cases:** 0 differing pixels.

The port follows Infinite's `tools/genforge` at `52e6547`. A copy is committed
under `upstream/genforge/`, with its provenance in `src/core/pixel/UPSTREAM.json`.

## API (stable; images-core depends on it)

```ts
import { filterImage, decodePng, encodePng, iconPrompt } from '@core/pixel';

const src = decodePng(bytes);                        // Uint8Array (main reads the file) → RgbaImage
const { image, report } = filterImage(src, {
  target: { w: 16, h: 16 },
  preset: 'item',                                    // 'item' | 'sprite' | 'texture' | 'none'
  // settings: { ... }                               // optional: REPLACES the preset (Genforge's --settings)
});
const out = encodePng(image);                        // → Uint8Array (main writes it atomically)
```

### `filterImage`

- **Images:** `RgbaImage = { width, height, data: Uint8ClampedArray }`,
  straight RGBA8, row-major.
- **What it is:** Genforge's `filters.render(crop, size, PRESETS[preset])`.
  It's pure and deterministic, and it never mutates its input.
- **Errors:** it throws `PixelError` for:
  - a size mismatch
  - a target that isn't an integer in 1..4096
  - an unknown preset
  - `item` with a non-square target (as `genforge/cli.py` refuses)
  - settings that aren't ported (listed under Gaps)
- **`report`:** `{ preset, settings, source, target, colors, opaquePixels, upstream }`.
  - `settings` is what ran (`null` for `none`). Store it in
    `ImageMeta.origin.settings`.
  - `upstream` is the Genforge revision.
  - `report.provisional` is **gone**: the port is no longer provisional.
- **Settings:** `PixelSettings` is Genforge's settings shape (`downscale`,
  `colors`, `outline`, `cleanup`, `alpha`, and for items `hairlines`,
  `halo_floor`, `crop_threshold`, `blur`, `alpha_threshold`, `outline_darken`).
  The old provisional fields (`paletteSize`, `rim`, …) no longer exist.
- **Presets:** `PRESET_SETTINGS` holds Genforge's `plans.py` PRESETS,
  verbatim:

| Preset | Settings |
|---|---|
| `item` | `{ downscale: 'item', colors: { count: 16 }, hairlines: true }` |
| `sprite` | `{ downscale: 'edge_preserving', colors: { count: 16, pick: 'variance' }, outline: 'rim' }` |
| `texture` | `{ downscale: 'area', colors: { count: 16, pick: 'variance' }, outline: 'none' }` |
| `none` | `null`: Genforge's plain resample (a copy, BOX when shrinking, else NEAREST) |

### The rest of the API

- **PNG:** `decodePng` and `encodePng` over `fast-png@8.0.0`. It's pure JS, so
  it's allowed in core. Every colour type and bit depth decodes to RGBA8.
- **Prompts:** `iconPrompt(entity, world, art?) → string` and
  `sheetPrompt(entities, layout, world, art?, { background? })`. `Entity` and
  `World` from `@core/model` can be passed straight in, and `art` is
  `world.settings.art`.
- **Sheets:** `sheetLayout`, `drawGuide` and `cropSheet` are covered under
  Icon sheets below.

## What was ported, and how

```
src/core/pixel/
  filter.ts     genforge/filters/__init__.py: render → _prepare/_finish, _downscale, _palette, _map, _outline, _cleanup, _snap
  items.ts      genforge/filters/items.py: render_item, convert_item, hairlines, every stage they call
  topology.ts   genforge/filters/topology.py: labels, negative space, _pool_source, _grammar_mask, _contour,
                _apply_material_rim, allocate_adaptive_palette
  presets.ts    genforge/plans.py PRESETS (verbatim) + the upstream revision
  pil.ts        bit-exact Pillow 12.3: Resample.c (BOX, LANCZOS; fixed-point, two-pass), BoxBlur.c (GaussianBlur),
                Geometry.c (NEAREST), Convert.c (RGBA↔RGBa), Image.resize's Python layer
  cv.ts         OpenCV 4: MORPH_ELLIPSE kernels, erode/dilate (default border), 8-way components with stats
  py.ts         Python/NumPy semantics: round-half-even, float %, colorsys, NumPy pairwise summation
  png.ts, sheet.ts, prompts.ts, errors.ts, types.ts, index.ts, UPSTREAM.json
```

### The stages, as Genforge runs them

- **`item`:** this is Genforge's 16×16 converter, and it has the most stages:
  - `halo_attenuate` (floor 0.10)
  - `tight_alpha_crop` at alpha ≥ 89
  - `fit_material`: linear-light, premultiplied LANCZOS, with a 0.40 Gaussian
    blur on alpha and each plane
  - `quantize_material`: a median cut over unique colours, so rare glints
    survive
  - `apply_local_inner_rim`: inward-anchored dark rim colours, quantised to
    up to 4 and run-smoothed
  - `hairlines`: thin source parts (bow strings) found by morphological
    opening and redrawn as one-pixel lines
- **`sprite`:** labels the components and partitions the negative space into
  exterior, holes and channels. Then it pools the source into the grid
  (`_pool_source`) and builds the silhouette with `_grammar_mask`: edge
  promotion, component preservation, bridges, strands, notches, softness
  pruning, orphans and path restoration. After that come
  `allocate_adaptive_palette` (variance split), nearest-colour mapping and
  `_apply_material_rim`.
- **`texture`:** Pillow BOX on premultiplied RGBA, an alpha ≥ 128 mask, the
  adaptive palette and nearest-colour mapping.
- **`none`:** `imaging.resample`.

### Why it's exact

Genforge's maths isn't only Python. A port that "does the same thing" drifts
by ±1 levels everywhere. Four deliberate pieces close that gap:

1. **Pillow is emulated in its C arithmetic**, not approximated:
   - 22-bit fixed-point coefficients and the two-pass order, with rows
     restricted to `ybox_first..last`
   - `clip8`
   - the float32 `_gaussian_blur_radius`
   - the UINT32 box-blur accumulators and `(bulk + 2²³) >> 24`
   - `MULDIV255` premultiplication
   - the RGBA → RGBa → RGBA detour `Image.resize` takes

   `pil.test.ts` checks 60 operations against Pillow byte for byte; the
   fixtures come from `scripts/pixel-pillow.py`. An earlier run of 280 random
   cases matched too.
2. **NumPy's float32 semantics** are reproduced at each site where they decide
   a pixel (all were established empirically against NumPy 2.5.4):
   - Comparing a float32 array with a Python float happens **in float32**
     (NEP 50), so thresholds are `fround(0.22)` and so on. A value wrapped in
     `float(...)` compares in float64 against the plain literal.
   - `region.sum()` over a strided float32 block is NumPy's **pairwise sum
     over buffered chunks of whole rows**, with `floor(8192/width)` rows per
     chunk. A contiguous block is one pairwise run. I tested both hypotheses
     on 3,000 and 40 random blocks before relying on them.
   - `(h,w,3).sum(axis=(0,1))` accumulates sequentially.
   - `.mean()` is `fround(sum / n)`.
3. **Python semantics:** `round()` and `np.rint` are half-to-even, float `%`
   takes the divisor's sign, `colorsys` is ported verbatim, and `max` and
   `min` ties and stable sorts are kept.
4. **Set and dict orders.** `items.py` iterates Python sets of positions. I
   checked that nothing depends on that order: the palettes sort totally,
   smoothing applies its changes after each pass, and `Counter.most_common(1)`
   ties follow neighbour order, which is reproduced.

## Parity results

There are 135 references from the real Genforge (`genforge filter SRC
--target WxH --preset P`). They come from 9 sources:

- six synthetic shapes: a disc, a gradient, a checker with holes, soft alpha,
  1–3 px lines, and non-square noise
- two icon-like illustrations at 512²: a sword and a potion
- `bow-1024`, a provider-sized bow whose string exercises `hairlines` (10
  redrawn pixels at 16², 22 at 32²)

Every reference matched with **0 differing pixels and a max channel delta of
0**:

| Preset | Targets | References | Differing pixels | Max channel delta | Tolerance |
|---|---|---|---|---|---|
| `item` | 16×16, 24×24, 32×32 | 27 | 0 | 0 | exact (16 and 32 locked exact by a test) |
| `sprite` | 16×16, 32×32, 24×16, 13×21 | 36 | 0 | 0 | exact |
| `texture` | 16×16, 32×32, 24×16, 13×21 | 36 | 0 | 0 | exact |
| `none` | 16×16, 32×32, 24×16, 13×21 | 36 | 0 | 0 | exact |

No tolerance was needed anywhere, so every preset asserts exact equality.

**Fuzzing** (`scripts/pixel-fuzz.py`, then `PIXEL_FUZZ=<dir>` with
`src/core/pixel/fuzz.test.ts`) feeds random sprites (ellipses, rects, lines,
rings, translucency, blur, 24–420 px) through every preset at random targets
from 8 to 40 px, including `none` upscales. Three seeds, 1,520 cases, **0
differing pixels**.

Fuzzing caught one real bug, now fixed and covered by `cv.test.ts`. The packed
morphology's power-of-two run-ANDs treated positions left of the row as
neutral border, but at x < 0 those runs still cover in-row pixels. Rows are
now padded with a genuine margin of ones. The bug changed 1 pixel in 1,040
cases (an 8×8 item from a 50×408 source).

### Property tests (fast-check)

These hold for every preset:

- deterministic, report included
- exact output size
- integer bytes
- input untouched
- binary alpha, with zero RGB on transparent pixels, for `item`, `sprite` and
  `texture`
- `texture` stays within 16 colours
- an explicit palette is exact, outline shades included
- empty sources
- the rejected settings are rejected

**Idempotence: only `none`**, because that's where Genforge has it. I measured
Genforge's own second passes on 138 cases: `none` 0 differ, `item` 136,
`sprite` 99, `texture` 40. The port reproduces those non-idempotent outputs
exactly too (the parity above), so it doesn't assert a property the original
lacks.

## Measurements

Times are for one 1024×1024 source to 16×16, in Node 22.23 under Vitest on
this 4-core container. Each row is 10 runs after a warm-up.

| Source | Preset | Median | Best | Worst | Cold first call |
|---|---|---|---|---|---|
| dense 800-px disc (worst case) | item | 200 ms | 169 | 302 | 323 |
| | sprite | 150 ms | 82 | 244 | 250 |
| | texture | 15 ms | 14 | 20 | 18 |
| | none | 14 ms | 13 | 17 | 15 |
| `bow-1024` (typical icon source) | item | 215 ms | 127 | 242 | 162 |
| | sprite | 112 ms | 76 | 243 | 213 |
| | texture | 14 ms | 13 | 18 | 16 |
| | none | 13 ms | 12 | 15 | 13 |

The budget is 300 ms. `perf.test.ts` asserts it for every preset on both
sources, taking the best of 3 runs after a warm-up.

The first naive port took about 980 ms for `item`. Here's what fixed it,
**without changing a single result** (parity and fuzz were re-run after each
step):

- Bit-packed morphology: 32 pixels per word, power-of-two run-ANDs shared
  across kernel levels, and dilation as the complement of eroding the
  complement.
- A dedicated path for Pillow's radius-0 box blur (the 0.40 Gaussian),
  exactly a clamped 3-tap.
- Inlined neighbour loops in labelling and contours.
- A table for `halo_attenuate`.
- Reusing the pooled alpha sums.

Cropping a real 100-cell sheet takes about 0.1 s at 1440² and 0.3 s at 2880²
(transparent), and filtering all 100 crops to 16² about 570 ms.

## Icon prompts (Genforge's house style)

I studied all 42 files in `prompts/items/*.txt`. Each is one paragraph:

1. **An opening:** `A single <subject> inventory icon`, then a view
   (`, seen from the front`) or a description.
2. **A presentation clause by object type:**
   - tools: *Diagonal presentation, the stout wooden handle pointing bottom
     left and the head top right*
   - swords: *the grip pointing bottom left and the blade top right*
   - bows: *the bow arc bulging toward the top left*
   - helmets: *seen from the front at a slight three-quarter angle*
   - ingots: *a chunky trapezoid bar seen at a three-quarter angle from
     above*
   - rocks and vines have none
3. **The material.**
4. **A fixed closing.** It's verbatim in 41 of the 42 files; `wooden_bow`
   swaps one phrase.

`iconPrompt` builds exactly that structure:

- The pose comes from the entity's name first, then its subkind.
- The materials come from `made_from`.
- The detail is the first sentence of the description, or else the identity.
- The kind's art note is added as a sentence.
- The closing is Genforge's tail, verbatim.
- The art direction's palette words replace "muted earthy colours"
  (IMAGES.md §5), and Genforge's phrase stays when there are none.

`prompts.test.ts` reads the upstream files. It asserts that our tail ends 41
of them (`wooden_bow` is the documented exception), that all 42 open with *A
single … inventory icon*, and that the iron sword's presentation clause and
tail come out identical.

Examples:

```
A single Glass Lung inventory icon: a bellows of blown glass worn on the chest, made of lung glass. Short, exaggerated
chunky proportions, large readable shapes, muted earth tones, clean pixel-friendly illustration, flat even light, no
shadow, no text, no border, no surrounding objects. Transparent background. Leave generous space around the silhouette.
```

```
A single Rift Cleaver inventory icon: cuts the seam between bands. Diagonal presentation from bottom left to top right;
made of rift steel and ashwood. Chipped, well-used edges. Short, exaggerated chunky proportions, large readable shapes,
cold blue and silver colours, clean pixel-friendly illustration, flat even light, no shadow, no text, no border, no
surrounding objects. Transparent background. Leave generous space around the silhouette.
```

```
A single Ember Moss inventory icon, a material. Short, exaggerated chunky proportions, large readable shapes, muted
earthy colours, clean pixel-friendly illustration, flat even light, no shadow, no text, no border, no surrounding
objects. Transparent background. Leave generous space around the silhouette.
```

## Icon sheets (IMAGES.md §2a, `sheet.ts`)

```ts
const layout = sheetLayout(items.length, { w: 1024, h: 1024 });   // ≤100; near-square, max 10×10; gutter 2% of the short side
const guide = drawGuide(layout, { w: 1024, h: 1024 });            // send as image 1
const prompt = sheetPrompt(items, layout, world, art, { background: 'fully transparent' });
const cells = cropSheet(decodePng(bytes), layout, { background: 'auto' }); // or 'alpha' | [r,g,b]
// cells[i]: { index, region, bbox, crop: RgbaImage | null, flags, segmentation: 'alpha' | 'colour' }
// flags ⊂ empty | background_only | touches_edge | fragmented; then filterImage(cell.crop, { …, preset: 'item' })
```

**The guide follows Genforge's tile drafts** (`genforge/walls/draft.py` and
`prompts.py`):

- Flat colours on an invisible grid, with no drawn lines. Genforge's prompts
  explicitly forbid "grid lines or borders".
- Each colour is named in the prompt's words.
- The cells are MID-GREY (140, Genforge's `GROUND`) squares on a DARK GREY
  (78, its `FACE`) gutter. The earlier faint-box guide is gone.

**`sheetPrompt` follows Genforge's tile-sheet prompt.** It names the guide's
colours and says *Do not move, add, remove or resize any square*. Then it
states the item house style once, gives one line per cell by position, and
ends with Genforge's *Return the same framing at the same size.*

Not adopted: Genforge's per-art-pixel draft noise. It exists to keep a model
from leaving repainted surfaces flat, and a layout guide needs no texture.

**`cropSheet` registers the model's grid, then assigns each sprite to its
cell.** Real sheets from images-core:

| Sheet | Model | Drift at 2880² | Gutter |
|---|---|---|---|
| `items-sheet-100-flare` | `gpt-image-2.6-flare`, $0.106 | up to ~28 px | 58 px |
| `items-sheet-100-flare25` | `gpt-image-2.5-flare`, $0.043 | up to ~72 px, non-monotonic: rows 5–8 shift down, then back | 58 px |

Cutting by strict cell bounds flagged 48 of 100 good sprites on the first
sheet. The steps:

1. **Segment the whole sheet once** into 8-connected foreground parts:
   - by alpha (`a ≥ 128`)
   - by a given flat colour
   - or `auto`: alpha when there's any transparency, else the opaque model
     below

   Specks under 0.05% of a cell are ignored.
2. **Register the grid.**
   - **Banding:** the model draws an even grid, so the parts' centres form
     `rows` horizontal and `cols` vertical bands. When both axes split cleanly
     at their k−1 largest gaps (gaps ≥ 0.3 pitch, bands ≤ 0.6 pitch), a part's
     band ranks are its row and column, however far the grid drifts.
   - **The fallback**, when the bands aren't clean (a whole row missing): each
     part goes to the nearest *corrected* cell centre, and each row's and
     column's correction is the median offset of its sprites. This is
     iterated. A row or column with fewer than 3 sprites uses the sheet-wide
     median, or none at all.
   - Per-row and per-column offsets are always re-estimated from the final
     assignment.
3. **Opaque sheets segment twice when the grid drifted** (more than a
   quarter gutter). The background model and the flood seeds are re-sampled at
   the gutters and cell rings where the model actually drew them. Otherwise
   planned gutter lines run through drifted sprites and, on a backdrop-coloured
   sprite (grey iron on grey cells), seed the flood inside it. That case lost
   34 sprites at 2880² before the second pass, and 0 after.
4. **Crop** each cell's own parts, square-padded.

On a synthetic sheet whose rows drift 0.62 pitch and back, the previous rule
put 30 sprites in the wrong cell, and registration gets all 100 right.

**Opaque sheets.** A model may ignore the transparent-background request.
The real sheet came from the old guide and is transparent; its grungy backdrop
survives only as alpha 1–6. Opaque segmentation handles a textured backdrop and
the new guide repainted as background:

- **The background is a model, not one colour.** Up to 6 colours are sampled
  where sprites should not be: the sheet border, the planned gutters' centre
  lines, and a ring 2 px inside each cell. Each colour's tolerance is
  1.5 × its 95th-percentile spread + 8 (minimum 32). The percentile ignores
  sprite pixels that strayed into a ring; the factor reaches a texture's
  extremes.
- **Background must be connected to where background is known.** A sprite's
  interior that matches the backdrop (grey iron on the guide's MID-GREY
  cells) is enclosed by its outline, so it stays sprite. Thin outlines have
  1–2 px gaps, so the flood runs against the foreground dilated by `r`
  (4 px at 1440², 8 at 2880²), then regrows `r` steps through
  background-coloured pixels to give back the true edge.
- **Limits:**
  - A hole of exactly the backdrop colour, fully enclosed by the sprite (the
    eye of an iron key on grey cells), is kept as sprite.
  - Where an outline gap is wider than `r`, a matching rim can be nicked.
  - A soft glow below alpha 128 counts once composited, so boxes can be
    larger than in the transparent original.
  - Cropping an opaque 2880² sheet takes about 1.6 s, against about 0.3 s
    for a transparent one.

**Flags:**

- `empty`: own foreground under 0.5% of the cell.
- `background_only`: the empty cell is one flat colour, or the "foreground"
  fills over 97% of the cell.
- `touches_edge`: the sprite reaches past its **corrected** cell plus half a
  gutter (with a 1 px antialiased fringe per 1440 px), touches the sheet edge,
  or is merged with a neighbour's sprite: one part with 15% or more of its
  pixels in another cell that owns no sprite of its own. The robbed cell is
  flagged `empty` + `touches_edge`.
- `fragmented`: more than one large part (≥ 15% of the largest and ≥ 1% of
  the cell's foreground).

**Regression tests:**

- **Both real sheets** (`fixtures/pixel/sheets/`, stored at 1440²): 100 crops
  each, **0 flags**, each box centred within its cell, and every crop filters
  to a 16×16 icon.
- **No clipping:** every sprite pixel (alpha ≥ 128) in the 2 px ring just
  outside a crop belongs to another crop.
- **Both real sheets composited opaquely** over a grungy textured backdrop, a
  stained parchment and the repainted guide with noise: **0 flags** each.
  Every box lies between the transparent original's alpha-128 box and its
  visible extent (alpha ≥ 8), within the 3 px fringe.
- **Synthetic cases:**
  - drift past half a pitch and back
  - a missing row (the fallback)
  - drift into the gutter
  - a centre in a gutter
  - a bridge between two sprites
  - a sprite off the sheet edge
  - empty and flat cells
  - fragmentation
  - ±12 noise
  - an explicit background and forced alpha
  - a sheet returned at another size

Times, measured on the real sheets:

| Sheet | Size | Background | Crop time |
|---|---|---|---|
| real | 1440² | transparent | about 0.1 s |
| real, upscaled | 2880² | transparent | about 0.3 s |
| real, upscaled | 2880² | opaque, guide repainted | about 1.6 s (two passes) |

Filtering 100 crops to 16² takes about 570 ms.

## Regenerating

```sh
python3 -m venv <venv> && <venv>/bin/pip install ./upstream/genforge     # Pillow 12.3, NumPy 2.5, OpenCV 4.14
node scripts/pixel-sources.mjs                                            # fixtures/pixel/sources (deterministic)
node scripts/pixel-references.mjs --genforge upstream/genforge --python <venv>/bin/python \
     --revision 52e6547bac6e4022abcc21e0820359ea3966a649                  # fixtures/pixel/reference + manifest.json
<venv>/bin/python -I scripts/pixel-pillow.py fixtures/pixel/pillow        # the Pillow-level fixtures
<venv>/bin/python -I scripts/pixel-fuzz.py <dir> <seed> <n> && PIXEL_FUZZ=<dir> npx vitest run src/core/pixel/fuzz.test.ts
```

Genforge is deterministic. Regenerating the references gives byte-identical
files; I checked by diffing two runs.

## Decisions

- **Settings replace the preset**, as Genforge's `--settings` does. A merge
  would invent semantics Genforge doesn't have.
- **Unported stages are refused, not approximated.** A silent approximation
  would break the "exact" claim for whoever sets them.
- **`item` requires a square target**, as Genforge's CLI does. `render_item`
  would crop a non-square one.
- **`upstream/genforge/` is committed** (as the coordinator asked) so the
  references can be regenerated in any checkout. Nothing in `src/` imports it.
- **Pillow and OpenCV are emulated only as far as Genforge uses them:**
  8-bit L and RGBA, BOX, LANCZOS and NEAREST, GaussianBlur, symmetric kernels.
- `package.json`: `fast-png@8.0.0` (exact), added in the first commit.
- `.prettierignore` gains one line, `upstream`. The Genforge copy must stay
  byte-identical to its recorded hashes, and Prettier would reformat its two
  layout JSON files.

## Gaps

- **Settings not ported,** each rejected with `PixelError`, none used by a
  preset:
  - `before` (blur, sharpen, grading: `_apply_pixel_palette_style`)
  - `vibrance`
  - `dither`
  - `noise` (needs NumPy's PCG64 stream)
  - `outline: outer`
  - `cleanup.symmetry` (and `_pool_source`'s symmetry branch)
  - `alpha: smooth`
  - `downscale: median`
  - `render_family`, `render_batch` and `palette_for_batch`
- **Pillow's resize path for images over 100× taller than wide** isn't ported.
  It resizes in two steps; no realistic icon source comes near it.
- **The cold first call** costs 160–320 ms while V8 compiles. Main should
  filter in a worker or tolerate one slow first icon.
- **Fuzz coverage** spans 24–420 px synthetic sprites; the committed
  references reach 1024². Huge sources (over 2048²) were not fuzzed, though
  the row-chunked sums are written for them and tested on 2000²-scale
  blocks.
