"""The free sample maps a kit comes with: every one valid for the heights the kit has sheets for."""

from __future__ import annotations

import numpy as np


def terrain(tall: str, n: int = 36) -> np.ndarray:
    """Plateaus, a mesa, notches and inlets. Drops: 1-tall kits use 1 only; 3-tall kits 2, 3, 5; both mix every drop."""
    h = np.zeros((n, n), int)
    if tall == "1":
        h[4:22, 3:21] = 1; h[10:15, 3:8] = 0; h[15:17, 12:16] = 0; h[6:13, 9:18] = 2
        h[14:31, 24:34] = 1; h[20:24, 28:34] = 0; h[26:31, 24:27] = 2
        h[26:32, 5:14] = 1; h[28:30, 7:9] = 0; h[2:6, 26:32] = 2
    elif tall == "3":
        h[4:22, 3:21] = 3; h[10:15, 3:8] = 0; h[16:20, 12:16] = 0; h[6:13, 9:18] = 5
        h[14:31, 24:34] = 3; h[20:25, 28:34] = 0; h[26:31, 24:27] = 5
        h[26:33, 5:14] = 3; h[27:31, 7:9] = 0; h[2:6, 26:32] = 5
    else:
        h[4:22, 3:21] = 3; h[10:15, 3:8] = 0; h[15:19, 12:16] = 0; h[6:13, 9:18] = 4; h[8:11, 11:14] = 5
        h[14:31, 24:34] = 3; h[20:25, 28:34] = 0; h[26:31, 24:27] = 4; h[27:29, 25:26] = 5
        h[26:32, 5:14] = 1; h[28:30, 7:9] = 0; h[2:6, 26:32] = 2; h[22:25, 14:20] = 1
    return h


def room(tall: str, n: int = 30) -> np.ndarray:
    """A classic big room: void around a floor whose north wall hangs below the void, a partition wall with a doorway and a block (a 1-tall counter when the kit has 1-tall walls)."""
    wall = 1 if tall == "1" else 3
    h = np.full((n, n), wall)
    h[wall:n - 1, 2:n - 2] = 0
    h[12 + wall:14 + wall, 2:13] = wall
    h[12 + wall:14 + wall, 17:n - 2] = wall
    if tall == "both":
        h[22:24, 18:26] = 1
    else:
        h[21:23, 18:26] = wall
    return h


def samples(kind: str, tall: str) -> dict:
    return {"map_1": room(tall) if kind == "room" else terrain(tall)}
