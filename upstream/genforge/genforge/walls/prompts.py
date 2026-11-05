"""The prompt of a wall sheet: a fixed template over the neutral mask, filled with the client's words.

The mask's colours are named in the template (the client never writes "mid-grey"); the client's words say what the
material is. Two kinds: `outdoor` (raised ground is the same ground, faces are cliffs, the lip is the rim) and `room`
(raised tops are empty black void, faces are walls, the lip is trim).
"""

from __future__ import annotations

from typing import Mapping

from .layout import COLS, ROWS, TILE

KINDS = ("outdoor", "room")
# slot -> (required, what it paints)
SLOTS = {
    "setting": (True, "where the camera is: 'a sunny desert canyon with sandstone mesas', 'the inside of a cosy cottage'"),
    "floor": (True, "the ground (outdoor) or floor (room) surface, with its colours"),
    "rim": (True, "the lip along the edge of raised ground (outdoor) or the trim along the wall tops (room)"),
    "face": (True, "the vertical wall face: material, layering or courses (brick, planks, stone strata), colours"),
    "extra": (False, "one more instruction for the model, appended before the no-shadow rules"),
}
NAMES = {"ground_name": "MID-GREY", "lip_name": "WHITE BAND", "face_name": "DARK GREY"}
VOID_NAME = "MID-GREY AREA INSIDE THE RAISED SHAPES (the same grey as the floor; it is where the wall tops are)"

OUTDOOR = """Image 1 is a draft of a tileset sheet for a top-down 2D RPG, seen from the classic three-quarter top-down game camera: {setting}. It is drawn in flat colours on an invisible grid of 64-pixel tiles. Repaint it as finished 16-bit pixel art by adding texture and detail INSIDE each shape. Do not move, add, remove, resize or reshape anything: every edge, band and wall stays exactly where the draft has it, at exactly the same size.

What the draft shows:
- The {ground_name} is the ground: {floor}. It is ONE surface everywhere on the sheet. The ground inside the raised areas is exactly the same ground, same colour, same brightness and same texture, as the ground outside them. Nothing is lighter, darker or tinted differently because it is higher.
- The {lip_name} is the lip along the edge of the raised ground: {rim}. Paint it the same thickness and look on every side, entirely inside the band: nothing from the band may spill into the neighbouring tile.
- {face_name} is a cliff face, the vertical front of raised ground seen straight from the front, hanging directly below the lip and exactly {tall}. Paint {face}. The thin darker lines across the face are where one layer ends and the next begins: keep each exactly where it is, perfectly level, and make it the subtle boundary between two tones, not a dark line. The DARK STRIP at the bottom of a face also runs down each side end of a face that meets open ground, the same width and colour as the bottom strip: it is where the rock meets the ground. No lip hangs down the side of a face.
{ref}
No shadows of any kind: no contact shadow, no dark halo, no gradient beside raised ground or under a face. Plain flat daylight. No flowers or plants of any kind, no props, loose rocks, characters, text, grid lines or borders."""

ROOM = """Image 1 is a draft of a tileset sheet for a top-down 2D RPG interior, seen from the classic three-quarter top-down game camera: {setting}. It is drawn in flat colours on an invisible grid of 64-pixel tiles. Repaint it as finished 16-bit pixel art by adding texture and detail INSIDE each shape. Do not move, add, remove, resize or reshape anything: every edge, band and wall stays exactly where the draft has it, at exactly the same size.

What the draft shows:
- The {ground_name} is the floor: {floor}. It is the same floor everywhere on the sheet.
- The {top_name} is empty void behind the walls: keep it solid flat black, with nothing painted in it, no texture and no stars.
- The {lip_name} is the trim along the edge of the void: {rim}. Paint it the same thickness and look on every side, entirely inside the band: nothing from the band may spill into the neighbouring tile.
- {face_name} is a wall face, the vertical front of the wall seen straight from the front, hanging directly below the trim and exactly {tall}. Paint {face}. The DARK STRIP at the bottom of a wall (the skirting) also runs down each side end of a wall that meets the open floor, the same width and colour as the bottom strip. No trim hangs down the side of a wall.
{ref}
No shadows of any kind: no contact shadow, no dark halo, no gradient beside the walls or under a face. Plain flat even light. No furniture, props, loose objects, plants, characters, text, grid lines or borders."""

TALL = {1: "one tile tall: every wall face is one tile tall", 3: "three tiles tall: every wall face is three tiles tall"}
REFERENCE = "Image 2 is a plain patch of the same ground: copy its palette, texture and scale for every {ground_name} area."
PIXEL_RULES = """

This is pixel art, not a painting. The layout is drawn on a pixel grid: every art pixel is a solid 4x4 block of image pixels, so each 64-pixel tile is 16x16 art pixels and the whole image is {art_w}x{art_h} art pixels. Paint at exactly that resolution: every art pixel one flat colour, aligned to the same 4-pixel grid as the layout. No anti-aliasing, no soft gradients, no blur, no detail smaller than one art pixel. Use a limited palette of about 16 to 20 colours arranged in clear light-to-dark ramps per material, in the style of a polished 16-bit console RPG."""
FRAMING = "\n\nReturn the same framing at the same size."


def check(material: Mapping) -> list[str]:
    """Problems with a material block (empty when fine)."""
    problems = []
    if material.get("kind") not in KINDS:
        problems.append(f"kind must be one of {', '.join(KINDS)}")
    for slot, (required, _) in SLOTS.items():
        if required and not str(material.get(slot, "")).strip():
            problems.append(f"missing {slot}")
    problems += [f"unknown slot {k}" for k in material if k not in SLOTS and k != "kind"]
    return problems


def build(material: Mapping, height: int, with_reference: bool, pixel_rules: bool = True) -> str:
    """The verbatim prompt for one sheet. `with_reference`: image 2 is a ground patch of the material's own other sheet."""
    kind = material["kind"]
    ref = REFERENCE.format(**NAMES) if with_reference else ""
    text = (OUTDOOR if kind == "outdoor" else ROOM).format(
        tall=TALL[height], ref=ref, top_name=VOID_NAME, **NAMES,
        **{slot: material.get(slot, "") for slot in SLOTS})
    if material.get("extra"):
        text = text.replace("\nNo shadows of any kind", "\n" + material["extra"] + "\n\nNo shadows of any kind", 1)
    rules = PIXEL_RULES.format(art_w=COLS * TILE, art_h=ROWS * TILE) if pixel_rules else ""
    return text + rules + FRAMING
