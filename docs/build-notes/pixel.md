# Build notes: pixel

## API (stable; images-core depends on it)

```ts
import { filterImage, decodePng, encodePng, iconPrompt } from '@core/pixel';

const src = decodePng(bytes);                       // Uint8Array (main reads the file) → RgbaImage
const { image, report } = filterImage(src, {
  target: { w: 16, h: 16 },
  preset: 'item',                                   // 'item' | 'sprite' | 'texture' | 'none'
  settings: { paletteSize: 12 },                    // optional per-call overrides
});
const out = encodePng(image);                       // → Uint8Array (main writes it atomically)
```

- `RgbaImage = { width, height, data: Uint8ClampedArray }`, straight RGBA8, row-major.
- `filterImage` is pure and deterministic. It throws `PixelError` on bad input
  (size mismatch, non-integer or out-of-range target, unknown preset, bad settings).
- `report`: `{ preset, settings (resolved), source, target, colors, opaquePixels, provisional, upstream }`.
  **`report.provisional === true` means the output is not yet the verified
  Genforge port**; store `report.settings` in `ImageMeta.origin.settings`.
- `iconPrompt(entity, world, art?) → string`: `Entity`/`World` from `@core/model`
  are assignable; `art` is `world.settings.art` (`{ direction?, notes? }`).

## Status: the Genforge port is blocked (read this first)

**No Genforge code has been ported, and there are no parity results.** The
Infinite repository (`Baladoodle/infinite`, which holds `tools/genforge`) is
private. Attaching it to this session with `add_repo` was refused by the
session's permission policy, and an unauthenticated `git clone` asks for
credentials. Nothing in `src/core/pixel/` was derived from Genforge's source,
its `prompts/items/*.txt` or `docs/filters.md`.

What exists instead, so the images-core work isn't blocked:

| Piece | State |
|---|---|
| `filterImage` API, types, errors, report | **Final shape.** Callers can integrate now |
| Filter maths (`filter.ts`, `quantize.ts`), preset values (`presets.ts`) | **Provisional, carbon's own.** `report.provisional === true`, `report.upstream === null` |
| Inner-rim path, topology-preserving pooling, Genforge's material rim | **Not implemented** (their definitions live only in Genforge's source) |
| PNG decode/encode (`png.ts`, over `fast-png`) | Done, tested |
| Fixture sources (`fixtures/pixel/sources/`, 8 images) | Done, regenerated deterministically by `scripts/pixel-sources.mjs` |
| Genforge references (`fixtures/pixel/reference/`) | **None.** They can only come from running the real Genforge |
| `scripts/pixel-references.mjs` | Written; its default Genforge command line is **unverified** (see below) |
| Parity test (`parity.test.ts`) | Harness done. With no references it is **skipped**, which is not evidence of parity |
| Property tests, perf test | Done, pass |
| `iconPrompt` (`prompts.ts`) | Done to the conventions IMAGES.md lists; **the house-style wording is carbon's**, not taken from the real prompt files |
| `UPSTREAM.json` | Records the files to hash, with `status: "not-ported"` and null hashes and revision |

**To unblock it:** allow `add_repo` for `Baladoodle/infinite` (or a permission
rule for `mcp__claude-code-remote__add_repo`), then:

1. Sparse-clone `tools/genforge`, `python3 -m venv .venv && .venv/bin/pip install ./tools/genforge`.
2. Port `filters/{__init__,items,topology}.py` stage by stage into
   `filter.ts`/`quantize.ts` (plus a `topology.ts`), and take the preset values
   from Genforge. Rewrite `prompts.ts` against `prompts/items/*.txt`.
3. Check `genforge filter --help`, then run
   `node scripts/pixel-references.mjs --genforge <path> [--cmd '<template>']`
   and commit `fixtures/pixel/reference/`.
4. `parity.test.ts` then runs every reference. All tolerances start at
   **exact**. Loosen one only after measuring, with the reason written here.
   `item` at 16×16 and 32×32 can't be loosened: a test enforces it.
5. Fill `UPSTREAM.json` (revision, sha256 per file), and set
   `report.provisional = false` and `report.upstream = <revision>`.

The API won't change when the port lands. Only pixels and preset values will,
so images that are stored keep `report.settings` and can be re-filtered for free.

## Icon sheets (IMAGES.md §2a, `sheet.ts`)

This was added after the contract gained §2a, which arrived in the merge. It
doesn't depend on Genforge.

```ts
import { sheetLayout, drawGuide, sheetPrompt, cropSheet } from '@core/pixel';

const layout = sheetLayout(items.length, { w: 1024, h: 1024 });   // ≤100; near-square, max 10×10; gutter 2% of the short side
const guide = drawGuide(layout, { w: 1024, h: 1024 });                                // white, 1-px #DCDCDC boxes just outside each cell → send as reference
const prompt = sheetPrompt(items, layout, world, art, { background: 'fully transparent' });
const cells = cropSheet(decodePng(bytes), layout, { background: 'auto' }); // or 'alpha' | [r,g,b]               // scales the grid if the model returned another size
// cells[i]: { index, region, bbox, crop: RgbaImage | null, flags, segmentation: 'alpha' | 'colour' }
// then: filterImage(cell.crop, { target: { w: 16, h: 16 }, preset: 'item' })
```

How the cropper works:

- **The cut:** each cell plus a margin into the gutter (half the gutter by
  default).
- **Segmentation:** by alpha (`a ≥ 128`) when the sheet has any
  transparency. Otherwise by colour: anything more than `tolerance` (32) in any
  channel from the median of the region's border.
- **The crop:** the foreground's bounding box, padded to a centred square,
  with the background made transparent.
- **Flags:**
  - `empty`: foreground under 0.5% of the region
  - `background_only`: empty, and the luminance range is ≤ 4, so it's just the flat
    background
  - `touches_edge`: the foreground reaches the region's border, so it may
    bleed into a neighbour. The test shows that a sprite crossing into the next
    cell flags that next cell too, which is what you want
  - `fragmented`: more than one large 8-connected component, meaning at least
    15% of the largest and 1% of the foreground
- **Noise:** a test jitters every channel by ±12; the default tolerance (32)
  still finds the exact boxes, and a speck-or-noise cell is `empty`, not
  `background_only`.
- **Speed:** cropping all 100 cells of a 1024² sheet takes about 96 ms, and
  filtering them all to 16² another 37 ms. At 2048², cropping takes about
  344 ms.

The prompt states the house style once (with Palette and per-kind Art notes),
then one line per cell: `row 1, col 1: Pickaxe, a chunky tool of Iron,
diagonal from lower left to upper right, handle at the bottom left.`

## Layout

```
src/core/pixel/
  index.ts        public exports (@core/pixel)
  types.ts        RgbaImage, PixelPreset, PixelSettings, FilterOptions, FilterReport
  filter.ts       filterImage, sRGB helpers (provisional maths)
  presets.ts      PRESET_SETTINGS, resolveSettings (provisional values)
  quantize.ts     deterministic median cut
  png.ts          decodePng / encodePng over fast-png
  prompts.ts      iconPrompt, sheetPrompt, paletteWords
  sheet.ts        sheetLayout, drawGuide, cropSheet (IMAGES.md §2a)
  errors.ts       PixelError
  UPSTREAM.json   provenance (not-ported)
  *.test.ts       filter, png, prompts, sheet, parity, perf
fixtures/pixel/sources/        8 deterministic sources
scripts/pixel-sources.mjs      regenerates the sources
scripts/pixel-references.mjs   regenerates the references from a Genforge checkout
```

`package.json`: added `fast-png@8.0.0`, exact pin, to `dependencies`. It is
pure JS (fflate and iobuffer), with no Node or DOM APIs, so it's allowed in
`src/core`. Main reads and writes the files and passes the bytes through.

## The provisional pipeline

These are the stages, in order:

1. **Resample:** exact fractional-area box weights per axis, so any scale
   factor works (`noise-300x200` exercises odd ratios).
2. **Linear light:** sRGB decoded through a 256-entry LUT, then re-encoded
   rounding half up.
3. **Halo fix:** colour weighted by alpha, so transparent pixels' RGB never
   bleeds into the edges.
4. **Alpha threshold:** a hard cut at `t·255`.
5. **Rim:** opaque pixels whose 4-neighbour is transparent or off the image
   are darkened by `rim`.
6. **Median-cut palette:** the colours already in the image are kept when
   there are no more than `n`, otherwise the nearest colour wins, ties to the
   lowest index.
7. **Canonical colour:** fully transparent pixels become `0,0,0,0`.

The rim runs **before** quantization. A property test caught the earlier order
creating more colours than `paletteSize`.

| Preset | linearLight | alphaThreshold | haloFix | paletteSize | rim | tileable |
|---|---|---|---|---|---|---|
| item | ✓ | 0.5 | ✓ | 16 | 0.25 | |
| sprite | ✓ | 0.5 | ✓ | 32 | 0 | |
| texture | ✓ | soft | | 32 | 0 | ✓ (opaque) |
| none | | soft | | – | 0 | |

## Parity results per preset

None yet. There are no Genforge references (see Status). The parity suite is
reported as **skipped**, deliberately, not as passing.

## Property tests (fast-check)

Over random images up to 40×40 and targets up to 32×32, for every preset:

- deterministic
- exact output size
- integer bytes in 0..255
- no NaNs
- input not mutated
- alpha in {0, 255} when there's a threshold
- `texture` opaque
- colour count ≤ `paletteSize`
- transparent pixels zeroed
- **idempotent at the same size for `sprite`, `texture` and `none`**

`item` isn't idempotent, because the rim darkens again on each pass. Whether
Genforge's item filter is idempotent is to be checked when porting. There are
also unit tests per stage (linear-light midpoint 188, halo, fractional
weights, rim, report, errors), and PNG tests (round-trip, grey, grey with
alpha, RGB, 16-bit, 1-bit and indexed decode, garbage).

`fast-png`'s **encoder** writes a one-entry `tRNS` for indexed images. Carbon
only ever encodes RGBA8, so this doesn't affect it. The decoder is correct.

## Measurements

These are for a 1024×1024 RGBA source in Node 22, under Vitest, in this
container. The figure is the median of 10 runs after the first.

| Preset | → 16×16 | → 32×32 | first call (cold JIT) |
|---|---|---|---|
| item | 9.2 ms | 9.2 ms | 40.9 ms |
| sprite | 8.6 ms | 9.5 ms | 8.4 ms |
| texture | 7.8 ms | 9.8 ms | 7.2 ms |
| none | 8.4 ms | 8.2 ms | 26.3 ms |

The budget is 300 ms. `perf.test.ts` asserts it per preset, taking the best of
3 runs after a warm-up. Topology-preserving pooling will cost more once it's
ported, and this test will keep it honest.

## Icon prompt: examples

`iconPrompt(entity, world, art)`. Sections in order: Subject, Details (the
first sentence of the description), Presentation (by item subkind), Proportions,
Materials (from `made_from`), Palette (the art direction's colour words only),
Art note (per kind), Light, Background, Never.

```
Subject: Glass Lung, an accessory: breathe where the air is poison.
Details: A bellows of blown glass worn on the chest.
Presentation: a single game inventory icon of the accessory, shown alone, upright and facing the viewer, centred.
Proportions: chunky and simplified, a bold readable silhouette that still reads at 16×16 pixels; exaggerate the one defining feature and drop fine detail.
Materials: made from Lung Glass; show each as a few large, clearly separated areas of flat colour.
Palette: muted earth tones.
Light: flat, even front light; no cast shadow, no glow, no reflections, no gradient background.
Background: fully transparent. The object fills about 80% of the frame with clear empty space around its whole silhouette; nothing touches or crosses the edges.
Never: text, letters, numbers, labels, borders, frames, outlines around the canvas, drop shadows, or a second object.
```

```
Subject: Rift Cleaver, a weapon: cuts the seam between bands.
Presentation: a single game inventory icon of the weapon, shown alone, diagonal from lower left to upper right, grip at the bottom left, centred.
…
Materials: made from Rift Steel; show each as a few large, clearly separated areas of flat colour.
Palette: cold blue, silver.
Art note: chipped, well-used edges.
…
```

```
Subject: Ember Moss, a material.
Presentation: a single game inventory icon of the material, shown alone, upright and facing the viewer, centred.
…
```

## Decisions

- **The API comes before the port**, so images-core can build against a
  stable shape. `report.provisional` keeps the provisional pixels from being
  mistaken for Genforge's.
- **No invented "Genforge" maths.** The provisional stages are generic and
  labelled as carbon's. The inner-rim path and topology pooling aren't faked,
  because guessing at them would make a later parity failure look like a
  porting bug.
- **Parity tolerances default to exact**, and a test fixes `item`
  16/32 at exact.
- **Small sources** (256 to 512 px, about 360 KB in total) keep the repo
  light. The 1024² perf source is built in memory.

## Gaps

- The whole Genforge port, the references and the parity results (see Status).
- The `prompts/items/*.txt` house style itself. The template follows only the
  bullet list in IMAGES.md.
- The default `genforge filter` flags in `scripts/pixel-references.mjs`
  (`--size WxH --out PATH`) are a guess. Pass `--cmd` after checking `--help`.
- There's no Genforge sample image in the fixtures, because the repository
  couldn't be read.
