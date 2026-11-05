# What genforge can make, and how freely to experiment

For agents. Genforge is not limited to the current `image`, `filter` and `tiles` commands. This page lists
other assets that are traditionally very hard to produce by hand but fit its approach, and what is known about
generation limits. **Experimenting is encouraged.** Nothing here is implemented unless noted; treat it as a
menu, not a spec.

## Cost and authorization
- A medium-quality call costs about $0.013 without a reference image and about $0.02 with one, so around
  50 test scenarios per dollar (figures from the project owner, 2026-10-15). Cost is not a constraint on
  exploring: try several prompts, sheet layouts and references before settling.
- Still pass an explicit `--max-calls N` on `run`, report what you spent, and do not retry a `pending` or
  `indeterminate` attempt (see [AGENTS.md](../AGENTS.md)). Keep experiments in `tools/genforge/runs/` (ignored) or a
  scratch folder, and commit only assets the task asks for.
- The project owner has years of pixel-art experience and is happy to touch up output by hand. An asset that
  is 90% right with a few wrong pixels is a useful result; say what needs fixing and deliver it anyway.

## What works and what doesn't (observed on single-shot sheets, low quality)
- **Works:** a coherent specimen with consistent style. The same rock in five environmental conditions stayed
  in one style and layout.
- **Fails:** cell layout without a guide (cells came out cropped or missing), animation frames (eight "frames"
  were near-identical and drew isometric blocks instead of flat faces) and progressions (eight crack stages
  did not get progressively worse).
- **So:** ask the model for one coherent specimen with a fixed guide, then derive sequences, progressions and
  animation in code or in the shader. Use the guide-plus-slicing approach of the `tiles` workflow for anything with many
  matching pieces. Fine detail averages away at 16x16, so ask for big chunky shapes and high contrast.
- These limits come from a few cheap samples, not exhaustive testing. If you find a prompt or layout that
  gets past one of them, write it down here.

## Why the voxel tileset worked
One coherent specimen, a guide that fixes where each state lives, then deterministic slicing into many mutually
consistent 16x16 pieces. By hand every piece has to match every other, which is what makes it slow. The best
candidates below share that "must match its neighbours or siblings" structure.

## Ideas, ranked by value for this game

### A. Same shape as the tileset (best fit)
1. **Overlay tilesets (dust, moss, snow, rime, ash, slime).** The 47 top + 36 side states, painted once as transparent
   edge-aware overlays (a fringe that creeps over the edge, thicker on the top face). Applies to ANY block, so
   M materials x N conditions costs M + N sets, not M x N. Fits the layer story directly: rime on everything in the
   Thin, ash in the Crush, moss in the Hollows, with one set each. Hand-painted this would be weeks.
2. **Material-transition tiles.** Grass into dirt into stone, sand into water, snow into rock. The tile docs list this as an unpainted gap
   (any solid counts as connected). Pairwise it grows O(n^2), but a generic "blend mask + two materials" approach, or
   a few shared transition shapes tinted per pair, keeps it small. Makes terrain stop looking like a grid of different wallpaper.
3. **Interior variant sets that tile with each other.** the connected-tile cost assessment flags that big flats visibly repeat,
   because rotation tricks break the lips. Generate 8 to 16 interior variants with matching edges (Wang-style) so large
   flats of stone or grass read as natural. Hand-matching edges across variants is miserable work.
4. **Linear connected sets (4-bit, 16 states).** Roots, vines, ropes and tethers (the wind shelf needs tethers),
   rails, pipes, waypoint conduits, sky-root segments, bridges. Same pipeline, much smaller (16 tiles).
5. **Column / pillar / trim kits.** Cap, shaft, base, plus a thick and a thin version; carved brick, arches and lintels.
   One-dimensional cousins of the side roles. Unlocks ruins and architecture that look authored, not built from cubes.

### B. Companion channels from the same specimen
6. **Emissive masks.** The lighting model has no base light, so glow is the main source of readable light. For each
   texture, a second image or threshold pass says which pixels emit (gills, ember veins, crystal, lantern). Makes bioluminescence
   cheap to author across every block and avoids tinting whole blocks.
7. **Break-progress overlays** (10 stages) derived procedurally from one crack image, so they progress and tile. Cheap and always needed.
8. **Weathering and decay ladders.** The same block as pristine, mossy, cracked and collapsed. Cheap way to make ruins and ancient structures feel old,
   and to show the "this place was not meant for you" feeling without new materials.
9. **Zone ladders.** One base rock in 5 environmental states, so a cliff can carry its zone with it from the meadow up to the Thin.

### C. Not tiles, but also hard by hand
10. **Creature and spirit sprite sheets** (billboards, 8 facings x idle/move) via reference-chained edits. High value, high risk: consistency across facings is the weak point, so expect a
    guide plus a manual pass. Giants seen at distance only need silhouette-quality art.
11. **Particle and atmosphere sprites.** Dust, spores, rime, embers, wind streaks, soft flares, god-ray shafts, light-shockwave
    rings, spirit wisps. Soft alpha, not 16x16. Directly serves "heavy atmosphere".
12. **Far-view art.** Cloud-floor textures, star fields for the Thin, "huge shapes at impossible distances" silhouettes,
    and impostor billboards of landmarks (sky spires) for the far LOD levels where block textures have already averaged away.
13. **Item families.** One tool shape across 6 material tiers and 8 tool types, with a consistent silhouette and recolor ramp, so progression reads at a glance.
14. **Crop and flora growth stages**, 4 to 5 per plant, matching the fantasy flora style.
15. **Concept references for the voxel builders.** A front/side/top three-view sheet gives agents a much stronger target for structures and creatures than prose, and could improve on the village test.
16. **UI kit.** 9-slice frames, burden icons, gauge pieces, map icons, in the same pixel style.
17. **Mood boards per layer.** Not game assets, but cheap key art to make zone design decisions before building anything.

18. **Non-cube block textures (chair, chest, vase).** Prototype works: render front/side/top silhouettes of the box model, have the model repaint them, bake onto a UV atlas. See [shaped-blocks.md](shaped-blocks.md).

## Suggested first picks
1. Overlay tilesets: biggest payoff, reuses the pipeline almost unchanged, every layer benefits.
2. Emissive masks: small, and the lighting model has no base light.
3. Interior variants: fixes the main visible weakness of connected tiles.
4. Break overlays: trivial, needed regardless.
Then material transitions once connected tiles have been seen in game.

## Before you ship anything
Review at native size, enlarged, and in game ([AGENTS.md](../AGENTS.md)). Connected tilesets need renderer
integration; generated assets do not enable themselves. Do not overwrite existing game textures automatically.
