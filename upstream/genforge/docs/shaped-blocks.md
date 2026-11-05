# Texturing non-cube blocks (chairs, chests, vases)

Status: prototype only (tested 2026-10-15 on a chair). The game now has model blocks (boxes at 1/16 resolution, see
`docs/ENGINE.md`, "Model blocks and placed structures"), textured by cutting a normal block texture by position. Genforge
atlases per shaped block are not wired in yet: that needs per-face UV rectangles in the block definition.
Sample code and a sample run: [../prototypes/shaped-chair/](../prototypes/shaped-chair/).

## What failed
- **Painting the UV layout directly.** Giving the model a flat UV image (coloured island per face) and asking it to
  paint in place does not work: it re-flows, resizes and drops islands, so texels no longer line up. Passing
  the islands as an edit `mask` did not fix it, because the mask is not enforced.
- **Plain concept sheets.** Front/side/top views drawn from a prompt alone are good looking but their size and
  proportions don't match any model, so they can't be baked precisely.

## What worked: the three-view method
1. **Model.** A shaped block is a set of axis-aligned boxes in texel units (1 texel = 1/16 block, Y up, front = +Z).
   `uvkit.py` has the chair as 6 boxes, packs every box face into an atlas (shelf packing) and can render previews.
2. **Guide.** `views.make_views_guide` renders flat orthographic front, side and top silhouettes of the model on a
   magenta background, one flat colour per part (lighter wood for the seat, darker for the legs). Silhouettes are what the
   model keeps in place; textured detail it invents.
3. **Paint.** One `/v1/images/edits` call (gpt-image-1, medium, 1536x1024, ~$0.02) with the guide as the image and
   `prompt-views.txt`. Ask for no outline outside the silhouette. Position and proportions came back accurate.
4. **Parse and bake.** `bake.py` finds the three painted views by their non-magenta bounding boxes, resamples
   each to the model's texel grid (averaging foreground only), flips a view back if its silhouette matches the mirror better
   (the model mirrored the side view once), then fills every UV face from the view whose axes it matches. Hidden
   faces are darkened copies of the visible ones. The atlas is quantized to 24 colours.

Cost of the whole chair: one paint call. The first two failed approaches cost two more.

## Known flaws, fix by hand
Seams between faces are not matched; undersides and backs are copies; the view outline is baked into faces; thin parts
(2 texels) are crude; per-part material control only comes from the guide colours and prompt.

## Ideas to improve
Separate back and underside views (6-view sheet), a second pass that re-paints each face with edge context, seam
copying along shared 3D edges, emissive masks for glowing parts, and a real `genforge shaped` command once the game
has a box-model format with per-face UV rectangles. Reading `model.json` (box list plus UV rects) is the intended contract.
