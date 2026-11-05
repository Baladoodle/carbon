"""Assemble the tile kit from evaluated sheets and export it.

Per tile state, in order: every usable candidate of every sample, best first (these are the tiles a map uses); if none is
usable, the usable candidates of the same wall with "raised beside" read as "wall continues" (the plain face looks the same),
marked `borrowed`; if none, the best faulty candidate of the state itself, marked `demoted`. A state that has nothing is
`missing`. Candidates that are not used stay available through `variants` (experimental).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from .evaluate import USABLE, Candidate, Sheet
from .layout import TILE, states as board_states

EDGE_NAMES = ("n", "e", "s", "w", "ne", "nw", "se", "sw")
COLUMNS = 16
FLOOR_MAX = 400


def state_id(key) -> str:
    """('edge', (n, e, s, w, ne, nw, se, sw)) -> 'edge:n.e'; the raised interior is 'edge:interior'; ('face', (role, w, e)) -> 'face:top:O:F'."""
    kind, value = key
    if kind == "edge":
        on = [name for name, flag in zip(EDGE_NAMES, value) if flag]
        return "edge:" + (".".join(on) or "interior")
    return "face:" + ":".join(value)


def parse_state(sid: str):
    kind, rest = sid.split(":", 1)
    if kind == "edge":
        on = set() if rest == "interior" else set(rest.split("."))
        return ("edge", tuple(name in on for name in EDGE_NAMES))
    return ("face", tuple(rest.split(":")))


def borrowed_key(key):
    """The same wall face with 'raised beside' (T) read as 'wall continues' (F); None when the state has no T side."""
    if key[0] != "face":
        return None
    role, west, east = key[1]
    alt = ("face", (role, "F" if west == "T" else west, "F" if east == "T" else east))
    return alt if alt != key else None


@dataclass
class Tile:
    image: np.ndarray
    fault: float
    sheet: int                       # index into Kit.sheets
    cell: tuple[int, int]
    borrowed_from: tuple | None = None


@dataclass
class Kit:
    kind: str
    sheets: list                     # [{"tall": 1|3, "sample": n}] per evaluated sheet
    states: dict                     # height -> {key: [Tile]} the tiles maps use, best first
    flags: dict                      # height -> {key: "demoted" | "borrowed" | "missing"} (absent: fine)
    floor: list                      # [Tile]
    unused: dict = field(default_factory=dict)   # height -> {key: [Tile]} candidates not used (faulty or duplicates)
    expected: dict = field(default_factory=dict)  # height -> set of keys the board has


def assemble(evaluated: list[tuple[int, int, Sheet]]) -> Kit:
    """evaluated: [(height, sample, Sheet)] in a fixed order. Samples pool: a state takes its usable candidates from all of them."""
    kind = evaluated[0][2].kind
    sheets = [{"tall": h, "sample": s} for h, s, _ in evaluated]
    kit = Kit(kind, sheets, {}, {}, [], {}, {})
    for height in sorted({h for h, _, _ in evaluated}):
        pool: dict = {}
        for index, (h, _, sheet) in enumerate(evaluated):
            if h != height:
                continue
            for key, cands in sheet.candidates.items():
                pool.setdefault(key, []).extend(Tile(c.tile, c.fault, index, c.cell) for c in cands)
        for tiles in pool.values():
            tiles.sort(key=lambda t: (t.fault, t.sheet, t.cell))
        kit.expected[height] = board_states(height)
        kit.states[height], kit.flags[height], kit.unused[height] = {}, {}, {}
        for key in sorted(kit.expected[height], key=state_id):
            own = unique(pool.get(key, []))
            usable = [t for t in own if t.fault <= USABLE]
            alt = borrowed_key(key)
            alt_usable = [t for t in unique(pool.get(alt, [])) if t.fault <= USABLE] if alt else []
            if usable:
                kit.states[height][key], kit.unused[height][key] = usable, [t for t in own if t.fault > USABLE]
            elif alt_usable:
                kit.states[height][key] = [Tile(t.image, t.fault, t.sheet, t.cell, alt) for t in alt_usable]
                kit.flags[height][key], kit.unused[height][key] = "borrowed", own
            elif own:
                kit.states[height][key], kit.flags[height][key], kit.unused[height][key] = [own[0]], "demoted", own[1:]
            else:
                kit.states[height][key], kit.flags[height][key] = [], "missing"
    seen = set()
    for index, (_, _, sheet) in enumerate(evaluated):
        for c in sheet.floor:
            if c.tile.tobytes() not in seen:
                seen.add(c.tile.tobytes())
                kit.floor.append(Tile(c.tile, 0.0, index, c.cell))
    if len(kit.floor) > FLOOR_MAX:
        kit.floor = kit.floor[::len(kit.floor) // FLOOR_MAX + 1]
    return kit


def unique(tiles):
    seen, out = set(), []
    for t in tiles:
        if t.image.tobytes() not in seen:
            seen.add(t.image.tobytes())
            out.append(t)
    return out


def atlas_of(tiles: list[np.ndarray]) -> Image.Image:
    rows = max(1, (len(tiles) + COLUMNS - 1) // COLUMNS)
    atlas = np.zeros((rows * TILE, COLUMNS * TILE, 4), np.uint8)
    atlas[..., 3] = 255
    for i, t in enumerate(tiles):
        y, x = divmod(i, COLUMNS)
        atlas[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE, :3] = t
    return Image.fromarray(atlas)


def export(kit: Kit, name: str, image: str, *, all_variants: bool = False):
    """(atlas image, tileset dict, variants image | None, variants dict | None). Tile indices are atlas cells in reading order."""
    tiles, sets = [], {}

    def add(t: Tile) -> int:
        tiles.append(t.image)
        return len(tiles) - 1

    for height in sorted(kit.states):
        table = {}
        for key, ts in kit.states[height].items():
            entry = {"tiles": [add(t) for t in ts], "faults": [t.fault for t in ts]}
            if key in kit.flags[height]:
                entry["status"] = kit.flags[height][key]
            if ts and ts[0].borrowed_from:
                entry["borrowed_from"] = state_id(ts[0].borrowed_from)
            table[state_id(key)] = entry
        sets[f"h{height}"] = {"states": table}
    floor = [add(t) for t in kit.floor]
    atlas = atlas_of(tiles)
    tileset = {"geometry": "walls-v2", "name": name, "kind": kit.kind, "image": image, "tile_px": TILE, "columns": COLUMNS,
               "tilecount": len(tiles), "tall": sorted(kit.states), "sets": sets, "floor": floor,
               "sheets": kit.sheets, "usable_fault": USABLE, "rules": rules(kit)}
    if not all_variants:
        return atlas, tileset, None, None
    extra, listing = [], {}
    for height in sorted(kit.unused):
        for key, ts in kit.unused[height].items():
            if not ts:
                continue
            listing.setdefault(f"h{height}", {})[state_id(key)] = [
                {"tile": len(extra) + i, "fault": t.fault, "sheet": t.sheet, "cell": list(t.cell)} for i, t in enumerate(ts)]
            extra.extend(t.image for t in ts)
    variants = {"geometry": "walls-v2-variants", "tile_px": TILE, "columns": COLUMNS, "tilecount": len(extra), "unused": listing,
                "note": "Candidates not used by maps: faulty ones (fault above usable_fault) and every cell of a state that has better tiles. Atlas cells in reading order."}
    return atlas, tileset, atlas_of(extra), variants


def rules(kit: Kit) -> dict:
    return {
        "version": 1,
        "cells": "Each map cell has a height. A cell is a surface cell unless it lies in a face band. Faces hang below a surface cell whose south neighbour is lower by d: "
                 "d = 1 -> set h1 role 'single'; d >= 2 -> set h3 roles top, mid x (d - 2), foot. Surface cells use the set of the face hanging below them (h1 for d = 1, else h3).",
        "edge": "A surface cell's state is the flags of its 8 neighbours that are LOWER than it (n, e, s, w; a diagonal flag counts only when both its sides are not lower). "
                "A surface cell with no lower neighbour is floor" + (" (a room's raised interior is the interior state: void)" if kit.kind == "room" else "") + ".",
        "face": "A face state is role:west:east; a side is O (the neighbour column is open, lower ground), T (a taller surface beside) or F (another face).",
        "choice": "Choose among a state's tiles by fault (lower first), seam fit with placed neighbours and a reuse penalty; the faults are in the tileset.",
    }
