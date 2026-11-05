# Voxel tile families

One material uses **130 chosen tiles**: top 47, side 36 and bottom 47. It is a texture kit,
not a geometry generator. The model paints complete coverage-designed specimen boards;
code cuts and ranks exact tiles. No source pixels are repaired to make the tests pass.

The material JSON supplies `kind: outdoor`, `setting`, `floor`, `rim`, `face`, and `bottom`.
`extra` optionally adds an instruction. Top and ground share one surface. H3 supplies the
top/mid/foot rows of a tall wall; H1 supplies a wall that is one voxel tall. The additional
bottom sheet repaints the same board for downward-facing surfaces.

## Horizontal top and bottom faces

An exposed face has a solid owning voxel and air beyond its normal. Within its plane,
look at eight neighbors. A missing solid is a set bit:

| Bit | Neighbor |
|---|---|
| 0–3 | north, east, south, west |
| 4–7 | northeast, northwest, southeast, southwest |

A diagonal bit counts only when both of its adjacent cardinal solids exist. The 256
raw neighborhoods therefore collapse to **47 masks**. The state key in `surfaces.top`
or `surfaces.bottom` is the mask's decimal string. `0` is interior; `15` has all four
cardinal edges exposed. Top and bottom use separate art with the same mask vocabulary.

## Vertical sides

All four wall directions share **36 existing states**, with local up always world-up:

| Role | Face above | Face below |
|---|---|---|
| `single` | absent | absent |
| `top` | absent | exposed |
| `mid` | exposed | exposed |
| `foot` | exposed | absent |

Each role has one of three situations on its left and on its right:

- `O`: no coplanar owning solid and no outward-layer solid (open end).
- `F`: coplanar owning solid, outward-layer air (face continues).
- `T`: outward-layer solid (the neighboring geometry turns inward or occludes the face).

That is `4 × 3 × 3 = 36` states, keyed as `role:left:right`, for example `top:O:F`.
No additional side artwork is needed for assigning textures in the reference selector.

## Orientation and lookup

Use this right/up basis when looking at each face from outside:

| Outward normal | Local right | Local up |
|---|---|---|
| +X | −Z | +Y |
| −X | +Z | +Y |
| +Y | +X | −Z |
| −Y | +X | +Z |
| +Z | +X | +Y |
| −Z | −X | +Y |

`genforge.voxel.select(solid, (x,y,z), normal)` returns `(surface, state)` or `None`.
The `solid` callable accepts one coordinate tuple. Atlas index lookup:

```python
family, state = select(solid, point, normal)
index = metadata["surfaces"][family][state]["tiles"][0]
column = index % metadata["columns"]
row = index // metadata["columns"]
```

Atlas crops are 16×16 pixels without gutters. A renderer should put them into separate
texture-array layers or add its own gutters and mip handling. Arbitrary UV rotations can
rotate a lip to the wrong edge; select the state in the matching face basis.

## What remains visual or engine work

- A side tile does not encode diagonal neighbors. A diagonal hole still has correct
  geometry, but cannot add a distinct corner accent to its diagonal neighbor's side tile.
- Concave and perpendicular joins share existing artwork; texture coverage does not prove
  seamless painting across these joins. Review ceilings, thin slabs, tunnels and corners.
- `solid` connects any occupied material. Material-to-material transitions are not painted
  by this kit; an engine must decide its material connectivity policy.
- The generated kit exposes faulty/borrowed selections in `review.json` and the state entries.
  A full state count does not mean every crop looks good.
- Infinite loads a block's tile export from `assets/textures/connected/<block name>/` (copy
  `atlas.png` and `tileset.json` from `output/`). It then meshes that block's faces by tile near the
  camera; see "Connected tiles in the game" below. A tileset without bottom states leaves the block's
  bottom as its plain `_bottom` texture.
- Save the source boards and review native-size tiles plus an actual 3D scene. No newly
  generated underside has been visually accepted by this tooling PR.

## Connected tiles in the game

- A block `infinite:name` is connected when `assets/textures/connected/name/` has a tile export. Its
  plain `name_top/_side/_bottom` textures draw far chunks and the whole block while the setting is
  off. Near the camera every face uses the export's tiles, interiors included, so the block looks
  the same as its edges (interiors still rotate or mirror per block; edge tiles never do).
- Off by default. `C` toggles it in game; `INFINITE_CONNECTED=1` starts with it on, and
  `INFINITE_CONNECTED_RADIUS` is how many chunks around the camera get it (default 2).
- Only level-0 chunks within that radius are meshed by tile. The mesher keys faces by block and tile, so
  runs of one tile still merge into one quad; a chunk also needs its edge neighbours (`iv_mesh::tiles`).
- Edge tiles are never rotated or mirrored, and `variation.ron` doesn't apply to them. Bottoms are viewed
  with right = +X, up = +Z as in the table above.
- Costs, measured on generated terrain with every block connected: about 1.7-2x quads in level-0
  chunks. Each connected block takes 130 texture layers (83 without bottoms).
