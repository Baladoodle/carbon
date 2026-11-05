# Genforge asset tools

Generate and edit images, run Genforge's pixel filters, and export connected voxel tile sets.
Everything runs in this repository: Python 3.11+, Pillow, NumPy and OpenCV. There is no server,
account service, YAML composer or dependency on the original Genforge checkout.

Run these commands from the repository root:

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install './tools/genforge[test]'
python tools/genforge --help
```

On Windows activate with `.venv\Scripts\Activate.ps1`. An installed environment also exposes
the same commands as `genforge`. Cloud setup and credentials: [docs/cloud.md](docs/cloud.md).

## Generate an image

First prepare a free plan. This copies the prompt and reference images, records their hashes,
and writes the exact provider settings. No key is required.

```sh
python tools/genforge image \
  --prompt-file tools/genforge/examples/item.txt \
  --target 16x16 --preset item \
  --out assets/generated/iron-pickaxe
```

Inspect `plan.json` and `inputs/`. The default model is `gpt-image-2.5-flare`, quality `low`,
with one 1024×1024 generation canvas. Override with `--model`, `--quality` or `--size`.
`--reference PATH` is repeatable and changes generation to an edit. `--mask PATH` applies to
the first reference: transparent mask pixels are editable. Reference pixels are saved as PNG.

Once the task's spend is authorized, supply `OPENAI_API_KEY` and execute:

```sh
python tools/genforge run assets/generated/iron-pickaxe --yes --max-calls 1
```

`output/image.png` is the final 16×16 image; `output/preview.png` is enlarged for review.
The unfiltered image remains in `sources/image.png`. A maximum call count is a quantity ceiling,
not a dollar quote. Check the selected model's [current pricing](https://developers.openai.com/api/docs/pricing)
before authorizing a run. This tool does not invent prices or reuse Genforge's provisional credits.

For a local key, copy `tools/genforge/.env.example` to the repository's `.env` and fill it in
outside Git. Injected environment values take precedence. Use `--env-file PATH` before the
subcommand to select a different local file. Never put a key in a CLI argument or commit it.

## Filter existing images

```sh
python tools/genforge filter path/to/source.png \
  --target 32x32 --preset sprite --out assets/generated/sprite.png
```

| Preset | Use |
|---|---|
| `item` | Square inventory icons; the tuned halo, linear-light fit and inner-rim path, validated at 16×16 |
| `sprite` | General sprites; topology-preserving pooling, 16-colour palette and material rim |
| `texture` | Opaque surface textures; area downsampling, 16 colours, no outline |
| `none` | Plain resizing without pixel filtering |

Use `--settings FILE.json` for the staged filter's controls instead of a preset. See
[docs/filters.md](docs/filters.md). Existing outputs are protected unless `filter --replace`
is explicit; a source cannot overwrite itself.

Generate clean illustrations with large readable shapes for sprites, then filter them. Tile
sets use the separate pixel-native specimen workflow below; filtering a cut tile again can
damage the borders that make it connect.

## Generate voxel tiles

```sh
python tools/genforge tiles --material tools/genforge/examples/meadow.json \
  --out assets/generated/meadow
```

This prepares **three medium 2048×1536 calls**: H3 stacked walls/top surfaces, H1 single walls,
and a bottom-surface sheet. Guides and verbatim prompts are in `inputs/`. H1 uses a ground
crop of H3 as a reference; the bottom sheet references H3's material. No new side categories
are introduced. After inspecting the plan and authorizing the spend:

```sh
python tools/genforge run assets/generated/meadow --yes --max-calls 3
```

The export contains **47 top + 36 side + 47 bottom states**, exact 16×16 crops:

- `output/atlas.png`, `tileset.json`: one selected tile per state, with fault/status metadata.
- `output/baseline/{top,side,bottom}.png`: the three interior textures for a conventional block.
- `output/preview.png`, `review.json`: enlarged atlas and exact source cells for visual review.
- `output/provenance.json`: plan, source-pixel and file hashes.

[docs/tilesets.md](docs/tilesets.md) explains masks, side roles, face orientation and limitations.
The Python reference selector is `genforge.voxel.select`. To use an export in the game, copy
`atlas.png` and `tileset.json` to `assets/textures/connected/<block name>/` and turn connected
tiles on (`C`, or `INFINITE_CONNECTED=1`); see [docs/tilesets.md](docs/tilesets.md). This tool
does not change any existing game assets.

## Retain, rebuild and recover

Each run directory is self-contained:

```text
plan.json                immutable settings and input hashes
inputs/                  copied references, masks, guides and prompts
sources/                 original provider images, never overwritten
receipt.json             attempts, usage and request IDs (generation only)
output/                  filtered images or tiles, previews and provenance
```

Keep the directory alongside the assets you approve. The scratch location `tools/genforge/runs/`
is ignored; `assets/generated/<name>/` can be committed when producing reviewable game assets.
No separate asset database is required.

```sh
python tools/genforge status assets/generated/meadow
python tools/genforge build assets/generated/meadow
```

`build` is free. To process existing full specimen images without generation:

```sh
python tools/genforge build assets/generated/meadow \
  --source h3=path/to/h3.png --source h1=path/to/h1.png --source bottom=path/to/bottom.png
```

Imports must match the planned dimensions. They are recorded as imported in provenance;
existing differing sources cannot be replaced. Wrong-size provider output remains retained
and fails processing, without another paid call.

There are no automatic retries. Every attempt is written before submission. A timeout,
unreadable response or interruption can mean a paid image already exists; that call remains
`pending` or `indeterminate` and blocks another `run`. An HTTP rejection is also retained and
not retried automatically. Keep the evidence and decide what to do before starting another run.
If a process was killed, inspect its receipt and any live process before removing `.run.lock`.

## Verify the port

```sh
python -m pytest -q tools/genforge/tests -c tools/genforge/pyproject.toml
```

Tests forbid real provider traffic and cover transport, accounting/recovery, filter parity,
tile extraction, all 256 horizontal neighborhoods in both orientations, and all 36 side cases
in four directions. `scripts/check.sh --py` runs them. `UPSTREAM.json` records the source snapshot,
file hashes and local adaptations; the preserved filters are compared to recorded upstream
pixel hashes. Source algorithms are unchanged apart from local imports and removal of unused
backend wrappers. Newly generated underside art and live provider execution remain unverified.
