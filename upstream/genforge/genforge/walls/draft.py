"""The neutral mask: one draft for every material.

Mid-grey ground (raised ground included: one surface), a white lip band along every raised edge, dark-grey faces with
level strata lines and a darker foot strip that also runs down the side of a face that meets open ground. What each grey
means is said in words (`prompts`), so the same image serves a desert canyon, a cave and a brick room.
`labels` is the class map the evaluation measures against: 0 ground, 1 raised top (rooms only: it is void there, not
ground), 2 lip and foot strip, 3 face.
"""

from __future__ import annotations

import numpy as np

from .layout import ART, CELL, board, classes, keys

GROUND = (140, 140, 140)
LIP_COLOR = (220, 220, 220)
FACE = (78, 78, 78)
COLORS = {"face": FACE, "strata": tuple(int(v * .78) for v in FACE), "foot": tuple(int(v * .42) for v in FACE), "lip": LIP_COLOR}
LIP, FOOT, STRATA_EVERY, NOISE_SEED = 16, 8, 32, 3


def draft(height: int, kind: str = "outdoor") -> tuple[np.ndarray, np.ndarray]:
    """(labels at image px, rgb) of the board for `height`-tall walls. `kind` only changes the labels: in a room the raised tops are void."""
    mask = board(height)
    kind_of, index = classes(mask, height)
    rows, cols = mask.shape
    labels = np.zeros((rows * CELL, cols * CELL), np.uint8)
    rgb = np.empty((rows * CELL, cols * CELL, 3), np.uint8)
    rgb[:] = GROUND
    if kind == "room":
        for y in range(rows):
            for x in range(cols):
                if kind_of[y, x] == "R":
                    labels[y * CELL:(y + 1) * CELL, x * CELL:(x + 1) * CELL] = 1

    def put(y, x, name, ys, xs, cls):
        rgb[y * CELL:(y + 1) * CELL, x * CELL:(x + 1) * CELL][ys, xs] = COLORS[name]
        labels[y * CELL:(y + 1) * CELL, x * CELL:(x + 1) * CELL][ys, xs] = cls

    full = slice(None)
    for (y, x), (what, key) in keys(mask, height).items():
        if what == "face":
            i = index[y, x]
            put(y, x, "face", full, full, 3)
            for ry in range(CELL):
                offset = i * CELL + ry
                if 0 < offset < height * CELL - FOOT and offset % STRATA_EVERY < ART:
                    put(y, x, "strata", slice(ry, ry + 1), full, 3)
            if i == height - 1:
                put(y, x, "foot", slice(CELL - FOOT, CELL), full, 3)
            if key[1] == "O":
                put(y, x, "foot", full, slice(0, FOOT), 3)
            if key[2] == "O":
                put(y, x, "foot", full, slice(CELL - FOOT, CELL), 3)
        elif what == "edge":
            n, e, s, w, ne, nw, se, sw = key
            for on, ys, xs in ((n, slice(0, LIP), full), (s, slice(CELL - LIP, CELL), full), (w, full, slice(0, LIP)), (e, full, slice(CELL - LIP, CELL)),
                               (ne, slice(0, LIP), slice(CELL - LIP, CELL)), (nw, slice(0, LIP), slice(0, LIP)),
                               (se, slice(CELL - LIP, CELL), slice(CELL - LIP, CELL)), (sw, slice(CELL - LIP, CELL), slice(0, LIP))):
                if on:
                    put(y, x, "lip", ys, xs, 2)
    noise = np.random.default_rng(NOISE_SEED).normal(0, 5, (rows * CELL // ART, cols * CELL // ART, 1)).repeat(ART, 0).repeat(ART, 1)
    return labels, np.clip(rgb.astype(float) + noise, 0, 255).astype(np.uint8)
