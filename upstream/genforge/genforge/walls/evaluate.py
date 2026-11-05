"""Cut a painted board into tile candidates and score each against the mask.

A candidate is an exact 16x16 crop of the sheet (no pixel changes) from a cell whose draft state it was painted for. Its
fault is how far its painted classes (ground, lip, face; learned from this sheet's own pixels) differ from the mask's, relative
to how well plain ground scores on the same sheet (ground is correct by definition, so a sheet whose model colours drift is not
punished as a whole): 0 is as good as plain ground, 1 is wrong everywhere. A fault demotes a tile in the ranking; nothing is
ever removed or repaired.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

from . import draft as D
from .layout import ART, CELL, TILE, board, keys

USABLE = 0.1            # a tile at most this faulty counts as usable (agreement >= 0.9 x plain ground's)
FLOOR_CLEAR = 9         # floor windows are cut this many art px (4 either side of the 16) clear of any lip, face or void
FLOOR_MAX = 400


@dataclass(frozen=True)
class Candidate:
    cell: tuple[int, int]
    fault: float
    tile: np.ndarray = None          # (16, 16, 3) uint8


@dataclass
class Sheet:
    height: int
    kind: str
    candidates: dict                 # state key -> [Candidate] best (lowest fault) first; exact duplicates dropped
    floor: list                      # [Candidate] plain-ground windows, fault 0
    baseline: float                  # median agreement of plain ground interior cells


def art_pixels(image: Image.Image) -> np.ndarray:
    """The sheet at art-pixel resolution: the middle pixel of every 4x4 block (the model is asked for solid blocks)."""
    return np.array(image.convert("RGB"))[ART // 2::ART, ART // 2::ART]


def class_models(labels: np.ndarray, art: np.ndarray):
    models = []
    for i in range(4):
        core = cv2.erode((labels == i).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        if core.sum() < 20:
            models.append(None)
            continue
        px = art[core].astype(float)
        models.append((px.mean(0), np.linalg.inv(np.cov(px.T) + np.eye(3) * 4)))
    return models


def painted_classes(art: np.ndarray, models) -> np.ndarray:
    px = art.astype(float)
    dist = [np.einsum("...i,ij,...j", px - m[0], m[1], px - m[0]) if m else np.full(px.shape[:2], 1e9) for m in models]
    return np.stack(dist, -1).argmin(2)


def evaluate(image: Image.Image, height: int, kind: str) -> Sheet:
    art = art_pixels(image)
    labels = D.draft(height, kind)[0][ART // 2::ART, ART // 2::ART].astype(int)
    kk = keys(board(height), height)
    rows, cols = labels.shape[0] // TILE, labels.shape[1] // TILE
    painted = painted_classes(art, class_models(labels, art))
    agree = {(y, x): float((painted[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE] == labels[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE]).mean())
             for (y, x) in kk}
    interior = lambda y, x: 1 < y < rows - 2 and 1 < x < cols - 2
    ground = [agree[c] for c, (what, _) in kk.items() if what == "flat" and interior(*c)]
    baseline = min(1.0, float(np.median(ground))) if ground else 1.0
    tile = lambda y, x: art[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE]
    found: dict = {}
    for (y, x), key in kk.items():
        if key[0] != "flat" and 0 < y < rows - 1 and 0 < x < cols - 1:
            found.setdefault(key, []).append(Candidate((y, x), round(float(max(0.0, 1 - agree[y, x] / baseline)), 4), tile(y, x)))
    candidates = {}
    for key, cells in found.items():
        seen, kept = set(), []
        for c in sorted(cells, key=lambda c: (c.fault, c.cell)):
            if c.tile.tobytes() not in seen:
                seen.add(c.tile.tobytes())
                kept.append(c)
        candidates[key] = kept
    # Plain-ground windows at any offset, clear of anything that is not ground (the model's lip texture spills past its band).
    near = cv2.dilate((labels != 0).astype(np.uint8), np.ones((FLOOR_CLEAR, FLOOR_CLEAR), np.uint8)).astype(bool)
    floor, seen = [], set()
    for y in range(0, labels.shape[0] - TILE + 1, 2):
        for x in range(0, labels.shape[1] - TILE + 1, 2):
            if near[y:y + TILE, x:x + TILE].any():
                continue
            t = art[y:y + TILE, x:x + TILE]
            if t.tobytes() not in seen:
                seen.add(t.tobytes())
                floor.append(Candidate((y // TILE, x // TILE), 0.0, t))
    if len(floor) > FLOOR_MAX:
        floor = floor[::len(floor) // FLOOR_MAX + 1]
    return Sheet(height, kind, candidates, floor, baseline)
