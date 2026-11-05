"""Place a kit's tiles on a height map (south faces only).

Cell rules are the ones in `kit.rules`. The picker is selection only: every cell chooses among its state's tiles the one whose
borders best continue its placed neighbours, with a penalty for repeating a tile nearby and a penalty that grows with the
tile's fault (a faulty tile is demoted, never forbidden). Maps must be valid: faces fit on the map, hold only lower ground and
no wall starts inside another (`check`).
"""

from __future__ import annotations

import random

import numpy as np

from .kit import Kit
from .layout import TILE

SEAM_SWEEPS, REUSE, FAULT_WEIGHT = 3, 1.5, 12.0


def bands(h: np.ndarray):
    """band[y, x]: row inside a wall face (or -1); owner[y, x]: row of the surface cell that owns the face; drop[y, x]: its height."""
    rows, cols = h.shape
    band, owner, drop = -np.ones((rows, cols), int), -np.ones((rows, cols), int), np.zeros((rows, cols), int)
    for y in range(rows - 1):
        for x in range(cols):
            d = h[y, x] - h[y + 1, x]
            for k in range(max(d, 0)):
                if y + 1 + k < rows:
                    band[y + 1 + k, x], owner[y + 1 + k, x], drop[y + 1 + k, x] = k, y, d
    return band, owner, drop


def check(h: np.ndarray) -> list[str]:
    """Why a height map cannot be tiled (empty when valid)."""
    problems, band, _, _ = [], *bands(h)
    rows, cols = h.shape
    for y in range(rows - 1):
        for x in range(cols):
            d = h[y, x] - h[y + 1, x]
            if d <= 0:
                continue
            if y + d > rows - 1:
                problems.append(f"({y},{x}): a face of {d} does not fit above the map's bottom")
            elif band[y, x] >= 0:
                problems.append(f"({y},{x}): a wall starts inside another wall's face")
            elif any(h[y + 1 + k, x] != h[y + 1, x] for k in range(1, d)):
                problems.append(f"({y},{x}): the face holds ground that is not lower")
    return problems


def keys_for(h: np.ndarray, room: bool = False) -> dict:
    """{(y, x): (kind, key, drop)} with kind 'edge' | 'face' | 'flat'; drop is the face height a surface cell has below it (0 if none)."""
    band, owner, drop = bands(h)
    rows, cols = h.shape
    out = {}

    def lower(y, x, dy, dx):
        yy, xx = y + dy, x + dx
        return 0 <= yy < rows and 0 <= xx < cols and h[yy, xx] < h[y, x]

    for y in range(rows):
        for x in range(cols):
            if band[y, x] >= 0:
                d, k = drop[y, x], band[y, x]
                role = "single" if d == 1 else "top" if k == 0 else "foot" if k == d - 1 else "mid"

                def side(xx):
                    if not 0 <= xx < cols or band[y, xx] >= 0:
                        return "F" if 0 <= xx < cols else "O"
                    return "T" if h[y, xx] > h[y, x] else "O"

                out[y, x] = ("face", (role, side(x - 1), side(x + 1)), int(d))
            else:
                n, e, s, w = (lower(y, x, -1, 0), lower(y, x, 0, 1), lower(y, x, 1, 0), lower(y, x, 0, -1))
                corner = lambda dy, dx, a, b: lower(y, x, dy, dx) and not a and not b
                key = (n, e, s, w, corner(-1, 1, n, e), corner(-1, -1, n, w), corner(1, 1, s, e), corner(1, -1, s, w))
                below = int(drop[y + 1, x]) if y + 1 < rows and band[y + 1, x] >= 0 and owner[y + 1, x] == y else 0
                out[y, x] = ("edge", key, below) if (any(key) or (room and h[y, x] > 0)) else ("flat", None, 0)
    return out


def _seam(left, right):
    """Border mismatch of (n,16,16,3) tile stacks placed left|right: the last and first pixel columns plus the gradient one pixel in."""
    return np.abs(left[:, :, -1] - right[:, :, 0]).mean((1, 2)) + .5 * np.abs((left[:, :, -1] - left[:, :, -2]) - (right[:, :, 1] - right[:, :, 0])).mean((1, 2))


def seam_energy(img: np.ndarray) -> float:
    t = img.astype(np.float32)
    rows, cols = img.shape[0] // TILE, img.shape[1] // TILE
    e = []
    for y in range(rows):
        for x in range(cols):
            c = t[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE]
            if x + 1 < cols:
                e.append(float(_seam(c[None], t[y * TILE:(y + 1) * TILE, (x + 1) * TILE:(x + 2) * TILE][None])[0]))
            if y + 1 < rows:
                e.append(float(_seam(c.transpose(1, 0, 2)[None], t[(y + 1) * TILE:(y + 2) * TILE, x * TILE:(x + 1) * TILE].transpose(1, 0, 2)[None])[0]))
    return float(np.mean(e))


def place(h: np.ndarray, kit: Kit, seed: int = 0) -> tuple[np.ndarray, dict]:
    """(rgb image at art px, report). Report: cells, demoted/borrowed/missing counts, seam energy."""
    problems = check(h)
    if problems:
        raise ValueError("invalid height map: " + "; ".join(problems[:3]))
    rng = random.Random(seed)
    room = kit.kind == "room"
    kk = keys_for(h, room)
    rows, cols = h.shape
    heights = sorted(kit.states)
    options, report = {}, {"demoted": 0, "borrowed": 0, "missing": []}
    for (y, x), (kind, key, drop) in kk.items():
        if kind == "flat":
            tiles = kit.floor
        else:
            order = [1, 3] if drop == 1 else [3, 1]
            tiles, status = [], None
            for height in order:
                if height in kit.states and kit.states[height].get((kind, key)):
                    tiles, status = kit.states[height][(kind, key)], kit.flags[height].get((kind, key))
                    break
            if status in ("demoted", "borrowed"):
                report[status] += 1
            if not tiles:
                report["missing"].append((y, x, kind, key))
                tiles = None
        if tiles is None:
            options[y, x] = (None, None, None)
        else:
            options[y, x] = (tiles, np.stack([t.image for t in tiles]).astype(np.float32), np.array([t.fault for t in tiles], np.float32))
    chosen = {}

    def cost(y, x):
        tiles, X, faults = options[y, x]
        c = FAULT_WEIGHT * faults
        if (y, x - 1) in chosen:
            c = c + _seam(np.repeat(chosen[y, x - 1][1][None], len(tiles), 0), X)
        if (y, x + 1) in chosen:
            c = c + _seam(X, np.repeat(chosen[y, x + 1][1][None], len(tiles), 0))
        if (y - 1, x) in chosen:
            c = c + _seam(np.repeat(chosen[y - 1, x][1].transpose(1, 0, 2)[None], len(tiles), 0), X.transpose(0, 2, 1, 3))
        if (y + 1, x) in chosen:
            c = c + _seam(X.transpose(0, 2, 1, 3), np.repeat(chosen[y + 1, x][1].transpose(1, 0, 2)[None], len(tiles), 0))
        if len(tiles) > 1:
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    o = chosen.get((y + dy, x + dx))
                    if o is not None and (dy or dx):
                        c = c + REUSE * np.array([t is o[0] for t in tiles], np.float32)
        return c + np.array([rng.random() * .05 for _ in tiles], np.float32)

    for _ in range(SEAM_SWEEPS):
        for y in range(rows):
            for x in range(cols):
                if options[y, x][0] is None:
                    continue
                chosen.pop((y, x), None)
                i = int(np.argmin(cost(y, x)))
                chosen[y, x] = (options[y, x][0][i], options[y, x][1][i])
    img = np.zeros((rows * TILE, cols * TILE, 3), np.uint8)
    img[:] = (255, 0, 255)
    for (y, x), (tile, _) in chosen.items():
        img[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE] = tile.image
    report.update(cells=rows * cols, missing_count=len(report["missing"]), seam_energy=round(seam_energy(img), 2))
    return img, report
