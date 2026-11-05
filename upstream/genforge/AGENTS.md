# Asset work

Read [README.md](README.md) for setup and commands, and [docs/tilesets.md](docs/tilesets.md)
before generating terrain. Run commands from the repository root. Genforge can make much more than
what the commands cover (overlays, emissive masks, variants, sprites, particles and more); see
[docs/possibilities.md](docs/possibilities.md) for ideas, cost (about $0.013 to $0.02 per medium call) and
known limits. Experimenting is encouraged.

- For non-cube blocks (chairs, chests, vases) read [docs/shaped-blocks.md](docs/shaped-blocks.md): painting a UV layout
  directly fails; the three-view method works.
- Establish subject, camera, scale and material words in a prompt text file or a material JSON.
  Use existing game assets as references when matching a family. Keep one art pixel per voxel
  texture texel: Infinite currently loads 16×16 block textures.
- `image` and `tiles` prepare guides, prompts and a plan without spending. Inspect these before
  `run`. Execute generation when the task calls for it, with the model, quality and call count stated;
  `run` requires `--yes --max-calls N`. The project owner has said cheap experiments are fine
  (see [docs/possibilities.md](docs/possibilities.md)); keep them small and report the spend. This PR's tests must never make real provider calls.
- Credentials come from `OPENAI_API_KEY`, a local ignored `.env`, or an explicit `--env-file`.
  Never print, copy into an issue/PR, or commit a credential. Cloud setup is in
  [docs/cloud.md](docs/cloud.md). GitHub repository secrets alone do not configure another agent runtime.
- Retain `plan.json`, `inputs/`, `sources/`, `receipt.json` and `output/provenance.json` together.
  A pending or indeterminate attempt may already have been charged. Do not retry it, remove its
  receipt or create a new run to bypass the block without the user's decision. `build` is free.
- Review final pixels at native size and enlarged, then review in the game. Coverage is not
  visual acceptance. Do not repaint generated tiles to hide broken extraction or seams.
- `output/baseline/{top,side,bottom}.png` can be copied deliberately to Infinite's named texture
  files. Connected `atlas.png` + `tileset.json` need a future renderer integration; they do not
  automatically enable connected texturing in the game.
- Keep changes scoped. Do not overwrite game textures automatically or regenerate unrelated art.
  For this tool run `python -m pytest -q tools/genforge/tests -c tools/genforge/pyproject.toml`.

The ported algorithms are tracked in `UPSTREAM.json`. Changes to them need behavior tests;
do not replace the recorded upstream filter hashes merely to make a test pass.
