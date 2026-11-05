"""The specimen boards and the tile states (south faces only).

A board is a binary mask of raised cells. A south face hangs below every raised cell that has non-raised ground to its
south, `H` cells tall (1 or 3); that is the only wall rule. Every state is read off the 3x3 neighbourhood:
  raised cell -> ('edge', (n, e, s, w, ne, nw, se, sw)): which neighbours are not raised; a corner counts only when both of
                 its sides are raised (47 blob states, the all-False key being the raised interior)
  face cell   -> ('face', (role, west, east)): role single | top | mid | foot; west/east O open ground, T raised beside,
                 F another face
  ground      -> ('flat', None)
Raised ground and ground are one surface, so the same mask serves every height level.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

import numpy as np

TILE = 16                       # art pixels per tile
CELL = 64                       # image pixels per tile on the sheet (4 image pixels per art pixel)
ART = 4
ROWS, COLS = 24, 32             # board cells; the sheet is 2048x1536
SHEET = (COLS * CELL, ROWS * CELL)
HEIGHTS = (1, 3)
DIR = Path(__file__).parent / "layouts"


@cache
def board(height: int) -> np.ndarray:
    """The designed board for 1-tall or 3-tall walls: a row of small recognisable patches, greedily covering every state twice."""
    if height not in HEIGHTS:
        raise ValueError(f"wall height {height}: one of {HEIGHTS}")
    mask = np.array(json.loads((DIR / f"board_H{height}.json").read_text())["mask"], bool)
    mask.flags.writeable = False
    return mask


def faces(mask: np.ndarray, height: int):
    """(face index within its wall or -1, row of the raised cell owning it), or None when a face would not fit."""
    rows, cols = mask.shape
    index, owner = -np.ones((rows, cols), int), -np.ones((rows, cols), int)
    for x in range(cols):
        for y in range(rows - 1):
            if mask[y, x] and not mask[y + 1, x]:
                for k in range(1, height + 1):
                    if y + k >= rows or mask[y + k, x] or index[y + k, x] >= 0:
                        return None
                    index[y + k, x], owner[y + k, x] = k - 1, y
    return index, owner


def classes(mask: np.ndarray, height: int):
    index, _ = faces(mask, height)
    return np.where(mask, "R", np.where(index >= 0, "F", "G")), index


def keys(mask: np.ndarray, height: int) -> dict:
    """{(y, x): ('edge', key8) | ('face', (role, west, east)) | ('flat', None)} for every cell of a mask."""
    kind, index = classes(mask, height)
    rows, cols = mask.shape
    out = {}

    def at(y, x):
        return kind[y, x] if 0 <= y < rows and 0 <= x < cols else "G"

    for y in range(rows):
        for x in range(cols):
            c = kind[y, x]
            if c == "R":
                n, e, s, w = (at(y - 1, x) != "R", at(y, x + 1) != "R", at(y + 1, x) != "R", at(y, x - 1) != "R")

                def corner(dy, dx, a, b):
                    return at(y + dy, x + dx) != "R" and not a and not b

                out[y, x] = ("edge", (n, e, s, w, corner(-1, 1, n, e), corner(-1, -1, n, w), corner(1, 1, s, e), corner(1, -1, s, w)))
            elif c == "F":
                role = "single" if height == 1 else "top" if index[y, x] == 0 else "foot" if index[y, x] == height - 1 else "mid"
                side = {"G": "O", "R": "T", "F": "F"}
                out[y, x] = ("face", (role, side[at(y, x - 1)], side[at(y, x + 1)]))
            else:
                out[y, x] = ("flat", None)
    return out


def states(height: int, interior_only: bool = True) -> set:
    """Every state a board of this height has at least one cell of, away from the sheet border (the border cells see 'ground' beyond it)."""
    kk = keys(board(height), height)
    rows, cols = board(height).shape
    return {k for (y, x), k in kk.items() if k[0] != "flat" and (not interior_only or (0 < y < rows - 1 and 0 < x < cols - 1))}


@cache
def ground_box(height: int = 3) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) in sheet px: the largest rectangle of the board that is plain ground with a full cell of margin from every wall.
    Cut from a painted sheet it is a ground patch of the material, the style reference of the other height's sheet."""
    kk = keys(board(height), height)
    rows, cols = board(height).shape
    clear = np.zeros((rows, cols), bool)
    for y in range(rows):
        for x in range(cols):
            clear[y, x] = all(kk.get((yy, xx), ("flat",))[0] == "flat" for yy in range(y - 1, y + 2) for xx in range(x - 1, x + 2)
                              if 0 <= yy < rows and 0 <= xx < cols)
    best, box = 0, None
    for y0 in range(rows):
        for x0 in range(cols):
            for y1 in range(y0 + 1, rows + 1):
                if not clear[y0:y1, x0].all():
                    break
                for x1 in range(x0 + 1, cols + 1):
                    if not clear[y0:y1, x0:x1].all():
                        break
                    if (y1 - y0) * (x1 - x0) > best:
                        best, box = (y1 - y0) * (x1 - x0), (y0, x0, y1, x1)
    y0, x0, y1, x1 = box
    return x0 * CELL, y0 * CELL, x1 * CELL, y1 * CELL
