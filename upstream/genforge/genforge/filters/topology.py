"""Discrete topology pixel-art converter engine with asset-specific adaptations.

Combines the topological edge and grammar reconstruction from frozen_topology_edge_v1
with V5's centroid-based island slicing, out-of-bounds boundary contouring, non-destructive
material rims, asset-type specific rules (seamless tiles with no borders), and adaptive
content-aware palette sizing.
"""

from __future__ import annotations

from collections import Counter, deque
import colorsys
import math
from typing import Any, Iterable, Optional, Sequence, Union
import numpy as np
from PIL import Image


RGB = tuple[int, int, int]
RGBA = tuple[int, int, int, int]
HARD_NAVY_OUTLINE: RGB = (24, 32, 48)


# ==============================================================================
# 1. Component Slicing & Sheet Isolation (from V5)
# ==============================================================================

def _component_labels_8way(mask: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """Label 8-connected components and return labels array and component sizes."""
    height, width = mask.shape
    labels = np.full((height, width), -1, dtype=np.int32)
    sizes: list[int] = []
    current_label = 0

    for y in range(height):
        for x in range(width):
            if not mask[y, x] or labels[y, x] >= 0:
                continue
            queue: deque[tuple[int, int]] = deque([(y, x)])
            labels[y, x] = current_label
            size = 0
            while queue:
                cy, cx = queue.popleft()
                size += 1
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dx == 0 and dy == 0:
                            continue
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and labels[ny, nx] < 0:
                            labels[ny, nx] = current_label
                            queue.append((ny, nx))
            sizes.append(size)
            current_label += 1

    return labels, sizes


def slice_sheet_components(
    image: Image.Image,
    rows: int,
    cols: int,
    alpha_threshold: int = 128,
    padding: int = 2,
) -> list[Image.Image]:
    """Slice a fixed-grid sheet using centroid component assignment to prevent border cropping.

    Each disconnected island is mapped to the grid cell containing its centroid.
    Overlapping adjacent sprites are masked out so tiles contain zero bleeding from neighbors.
    """
    rgba = image.convert("RGBA")
    alpha_mask = rgba.getchannel("A").point(lambda v: 255 if v >= alpha_threshold else 0)
    content_bounds = alpha_mask.getbbox()
    if content_bounds is not None:
        rgba = rgba.crop(content_bounds)

    width, height = rgba.size
    mask = np.asarray(rgba.getchannel("A"), dtype=np.uint8) >= alpha_threshold
    labels, sizes = _component_labels_8way(mask)

    boxes = [[width, height, 0, 0, 0, 0] for _ in sizes]
    for position, label in enumerate(labels.ravel()):
        if label < 0 or sizes[label] < 4:
            continue
        y, x = divmod(position, width)
        box = boxes[label]
        box[0] = min(box[0], x)
        box[1] = min(box[1], y)
        box[2] = max(box[2], x + 1)
        box[3] = max(box[3], y + 1)
        box[4] += x
        box[5] += y

    pitch_x = width / cols
    pitch_y = height / rows
    groups: list[list[int]] = [[] for _ in range(rows * cols)]
    for label, size in enumerate(sizes):
        if size < 4:
            continue
        box = boxes[label]
        center_x, center_y = box[4] / size, box[5] / size
        col = min(cols - 1, max(0, int(center_x // pitch_x)))
        row = min(rows - 1, max(0, int(center_y // pitch_y)))
        groups[row * cols + col].append(label)

    sprites: list[Image.Image] = []
    for index, group in enumerate(groups):
        row, col = divmod(index, cols)
        if group:
            left = max(0, min(boxes[label][0] for label in group) - padding)
            top = max(0, min(boxes[label][1] for label in group) - padding)
            right = min(width, max(boxes[label][2] for label in group) + padding)
            bottom = min(height, max(boxes[label][3] for label in group) + padding)
            crop = rgba.crop((left, top, right, bottom))
            pixels = np.asarray(crop, dtype=np.uint8).copy()
            allowed = set(group)
            for local_y in range(crop.height):
                for local_x in range(crop.width):
                    if pixels[local_y, local_x, 3] == 0:
                        continue
                    global_y, global_x = top + local_y, left + local_x
                    if labels[global_y, global_x] not in allowed:
                        pixels[local_y, local_x, 3] = 0
            sprites.append(Image.fromarray(pixels, "RGBA"))
        else:
            left = int(col * pitch_x)
            top = int(row * pitch_y)
            right = int(min(width, (col + 1) * pitch_x))
            bottom = int(min(height, (row + 1) * pitch_y))
            cell_crop = rgba.crop((left, top, right, bottom))
            sprites.append(cell_crop)

    return sprites


# ==============================================================================
# 2. Topology Analysis & Grammar Reconstruction (from frozen_topology_edge_v1)
# ==============================================================================

def _neighbors(x: int, y: int, width: int, height: int, diagonal: bool = True) -> Iterable[tuple[int, int]]:
    offsets = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    if diagonal:
        offsets.extend(((-1, -1), (-1, 1), (1, -1), (1, 1)))
    for dx, dy in offsets:
        nx, ny = x + dx, y + dy
        if 0 <= nx < width and 0 <= ny < height:
            yield nx, ny


def _label_components(mask: np.ndarray, diagonal: bool = True) -> tuple[np.ndarray, list[dict[str, object]]]:
    """Label components deterministically in row-major order."""
    height, width = mask.shape
    labels = np.zeros(mask.shape, dtype=np.int32)
    components: list[dict[str, object]] = []
    next_id = 0

    for y in range(height):
        for x in range(width):
            if not mask[y, x] or labels[y, x] != 0:
                continue
            next_id += 1
            queue: deque[tuple[int, int]] = deque([(x, y)])
            labels[y, x] = next_id
            min_x = max_x = x
            min_y = max_y = y
            area = 0
            while queue:
                cx, cy = queue.popleft()
                area += 1
                min_x = min(min_x, cx)
                max_x = max(max_x, cx)
                min_y = min(min_y, cy)
                max_y = max(max_y, cy)
                for nx, ny in _neighbors(cx, cy, width, height, diagonal=diagonal):
                    if mask[ny, nx] and labels[ny, nx] == 0:
                        labels[ny, nx] = next_id
                        queue.append((nx, ny))
            components.append(
                {
                    "id": next_id,
                    "area": area,
                    "bounds": (min_x, min_y, max_x + 1, max_y + 1),
                }
            )
    return labels, components


def _negative_space(mask: np.ndarray) -> tuple[np.ndarray, set[int], set[int], set[int]]:
    """Partition background negative space into exterior canvas, enclosed holes, and narrow channels."""
    labels, regions = _label_components(~mask, diagonal=False)
    height, width = mask.shape
    exterior: set[int] = set()
    for x in range(width):
        if labels[0, x]:
            exterior.add(int(labels[0, x]))
        if labels[height - 1, x]:
            exterior.add(int(labels[height - 1, x]))
    for y in range(height):
        if labels[y, 0]:
            exterior.add(int(labels[y, 0]))
        if labels[y, width - 1]:
            exterior.add(int(labels[y, width - 1]))

    holes = {int(region["id"]) for region in regions if int(region["id"]) not in exterior}
    scale = max(height, width)
    channels: set[int] = set()
    for region in regions:
        region_id = int(region["id"])
        if region_id not in exterior:
            continue
        x0, y0, x1, y1 = (int(v) for v in region["bounds"])
        region_area = int(region["area"])
        narrow = min(x1 - x0, y1 - y0) <= max(4, int(round(scale * 0.14)))
        long_enough = max(x1 - x0, y1 - y0) >= max(5, int(round(scale * 0.22)))
        if region_area >= max(8, int(mask.sum() * 0.00015)) and narrow and long_enough:
            channels.add(region_id)

    return labels, exterior, holes, channels


def _tight_bounds(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _pool_source(
    rgba: np.ndarray,
    source_mask: np.ndarray,
    source_labels: np.ndarray,
    source_hole_mask: np.ndarray,
    source_channel_mask: np.ndarray,
    target_size: tuple[int, int],
    margin: int = 1,
    is_tile: bool = False,
    anchor_mode: str = "center",
    scale_reference_height: Optional[int] = None,
    symmetry: bool = True,
    fit_bounds: Optional[tuple[int, int, int, int]] = None,
    coverage_from_mask: bool = False,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, tuple[int, int], tuple[int, int, int, int] | None]:
    """Pool high-res source evidence into target grid while retaining per-cell component ownership."""
    target_w, target_h = target_size
    bounds = (0, 0, rgba.shape[1], rgba.shape[0]) if is_tile else (fit_bounds or _tight_bounds(source_mask))
    empty_coverage = np.zeros((target_h, target_w), dtype=np.float32)
    empty_material = np.zeros((target_h, target_w, 3), dtype=np.float32)
    empty_float = np.zeros((target_h, target_w), dtype=np.float32)
    empty_ids = np.full((target_h, target_w), -1, dtype=np.int32)
    empty_bool = np.zeros((target_h, target_w), dtype=bool)

    if bounds is None:
        return empty_coverage, empty_material, empty_float, empty_float.copy(), empty_float.copy(), empty_ids, empty_float.copy(), empty_float.copy(), empty_bool, empty_bool.copy(), (0, 0), None

    left, top, right, bottom = bounds
    crop_rgba = rgba[top:bottom, left:right]
    crop_mask = source_mask[top:bottom, left:right]
    crop_labels = source_labels[top:bottom, left:right]
    crop_holes = source_hole_mask[top:bottom, left:right]
    crop_channels = source_channel_mask[top:bottom, left:right]
    height, width = crop_mask.shape

    if is_tile:
        span_w = target_w
        span_h = target_h
        fitted_width = target_w
        fitted_height = target_h
        offset_x = 0
        offset_y = 0
    else:
        span_w = max(1, target_w - 2 * margin)
        span_h = max(1, target_h - 2 * margin)
        ref_h = max(height, scale_reference_height) if scale_reference_height else height
        scale = min(span_w / max(1, width), span_h / max(1, ref_h))
        fitted_width = max(1, min(span_w, int(round(width * scale))))
        fitted_height = max(1, min(span_h, int(round(height * scale))))

        # Keep symmetric silhouettes centered on an even target grid. Without
        # this, a narrow symmetric source can quantize to an odd-width shape
        # whose center lands half a pixel off the canvas center.
        aspect = width / max(1, height)
        source_horizontal_symmetry = float(
            2.0 * np.sum(crop_mask & np.fliplr(crop_mask))
            / max(1, np.sum(crop_mask) + np.sum(np.fliplr(crop_mask)))
        )
        if 0.90 <= aspect <= 1.11 and span_w == span_h:
            fitted_dim = min(fitted_width, fitted_height)
            if target_w % 2 == 0 and fitted_dim % 2 == 1 and fitted_dim + 1 <= span_w:
                fitted_dim += 1
            fitted_width = fitted_dim
            fitted_height = fitted_dim
        if (
            target_w % 2 == 0
            and fitted_width % 2 == 1
            and fitted_width + 1 <= span_w
            and source_horizontal_symmetry >= 0.88
        ):
            fitted_width += 1
        offset_x = (target_w - fitted_width) // 2
        if anchor_mode in ("ground", "bottom"):
            offset_y = target_h - fitted_height - margin
        else:
            offset_y = (target_h - fitted_height) // 2

    coverage = np.zeros((target_h, target_w), dtype=np.float32)
    material = np.zeros((target_h, target_w, 3), dtype=np.float32)
    holes = np.zeros((target_h, target_w), dtype=np.float32)
    channels = np.zeros((target_h, target_w), dtype=np.float32)
    edge_strength = np.zeros((target_h, target_w), dtype=np.float32)
    dominant_ids = np.full((target_h, target_w), -1, dtype=np.int32)
    component_fraction = np.zeros((target_h, target_w), dtype=np.float32)
    edge_support = np.zeros((target_h, target_w), dtype=np.float32)
    side_support = np.zeros((target_h, target_w, 4), dtype=np.float32)
    presence = np.zeros((target_h, target_w), dtype=bool)

    crop_edge = np.zeros(crop_mask.shape, dtype=bool)
    crop_edge[0, :] = True
    crop_edge[-1, :] = True
    crop_edge[:, 0] = True
    crop_edge[:, -1] = True

    for ty in range(fitted_height):
        sy0 = min(height - 1, int(math.floor(ty * height / fitted_height)))
        sy1 = min(height, max(sy0 + 1, int(math.ceil((ty + 1) * height / fitted_height))))
        for tx in range(fitted_width):
            sx0 = min(width - 1, int(math.floor(tx * width / fitted_width)))
            sx1 = min(width, max(sx0 + 1, int(math.ceil((tx + 1) * width / fitted_width))))

            region_mask = crop_mask[sy0:sy1, sx0:sx1]
            region_labels = crop_labels[sy0:sy1, sx0:sx1]
            region_alpha = crop_rgba[sy0:sy1, sx0:sx1, 3].astype(np.float32) / 255.0

            y, x = offset_y + ty, offset_x + tx
            coverage[y, x] = float(region_mask.mean()) if coverage_from_mask else float(region_alpha.mean())
            holes[y, x] = float(crop_holes[sy0:sy1, sx0:sx1].mean())
            channels[y, x] = float(crop_channels[sy0:sy1, sx0:sx1].mean())
            presence[y, x] = bool(region_mask.any())

            region_rgb = crop_rgba[sy0:sy1, sx0:sx1, :3].astype(np.float32)
            alpha_sum = float(region_alpha.sum())
            if alpha_sum > 1e-6:
                # Keep straight-alpha RGB in low-coverage cells; geometry handles
                # sparse antialias evidence without introducing a light fringe.
                material[y, x] = (region_rgb * region_alpha[..., None]).sum(axis=(0, 1)) / alpha_sum
            else:
                material[y, x] = crop_rgba[sy0, sx0, :3]

            ids, counts = np.unique(region_labels[region_mask], return_counts=True)
            valid = [(int(cid), int(cnt)) for cid, cnt in zip(ids, counts) if int(cid) > 0]
            if valid:
                valid.sort(key=lambda pair: (-pair[1], pair[0]))
                dominant_ids[y, x] = valid[0][0]
                component_fraction[y, x] = valid[0][1] / max(1, int(region_mask.sum()))

            edge_pixels = region_mask & crop_edge[sy0:sy1, sx0:sx1]
            fg_count = max(1, int(region_mask.sum()))
            if sy0 == 0:
                side_support[y, x, 0] = float(region_mask[0, :].sum()) / fg_count
            if sx1 == width:
                side_support[y, x, 1] = float(region_mask[:, -1].sum()) / fg_count
            if sy1 == height:
                side_support[y, x, 2] = float(region_mask[-1, :].sum()) / fg_count
            if sx0 == 0:
                side_support[y, x, 3] = float(region_mask[:, 0].sum()) / fg_count

            edge_support[y, x] = float(edge_pixels.sum()) / max(1, int(region_mask.sum()))

            edge_count = 0
            total = 0
            for py in range(sy0, sy1):
                for px in range(sx0, sx1):
                    if not crop_mask[py, px]:
                        continue
                    total += 1
                    if (
                        crop_edge[py, px]
                        or not crop_mask[py, max(0, px - 1)]
                        or not crop_mask[py, min(width - 1, px + 1)]
                        or not crop_mask[max(0, py - 1), px]
                        or not crop_mask[min(height - 1, py + 1), px]
                    ):
                        edge_count += 1
            edge_strength[y, x] = edge_count / max(1, total)

    # Multi-axis silhouette-only symmetry regularization
    # Mirrors coverage, edge_strength, edge_support, side_support, and presence
    # Critically leaves material directional, but uses neighbor sampling for newly enabled pixels
    if symmetry and not is_tile and height > 1 and width > 1:
        flip_h = np.fliplr(crop_mask)
        sym_h = float(2.0 * np.sum(crop_mask & flip_h) / max(1, np.sum(crop_mask) + np.sum(flip_h)))
        flip_v = np.flipud(crop_mask)
        sym_v = float(2.0 * np.sum(crop_mask & flip_v) / max(1, np.sum(crop_mask) + np.sum(flip_v)))

        original_presence = presence.copy()
        original_coverage = coverage.copy()
        symmetrized = False

        # Recover minor left/right raster loss without treating diagonal props as
        # symmetric silhouettes.
        if sym_h >= 0.88:
            symmetrized = True
            for ty in range(fitted_height):
                py = offset_y + ty
                for dx in range((fitted_width + 1) // 2):
                    x1 = offset_x + dx
                    x2 = offset_x + fitted_width - 1 - dx
                    avg_cov = (coverage[py, x1] + coverage[py, x2]) / 2.0
                    coverage[py, x1] = coverage[py, x2] = avg_cov
                    avg_es = (edge_strength[py, x1] + edge_strength[py, x2]) / 2.0
                    edge_strength[py, x1] = edge_strength[py, x2] = avg_es
                    avg_supp = (edge_support[py, x1] + edge_support[py, x2]) / 2.0
                    edge_support[py, x1] = edge_support[py, x2] = avg_supp
                    presence[py, x1] = presence[py, x2] = (presence[py, x1] | presence[py, x2])

        if sym_v >= 0.92 and (sym_h >= 0.88 and 0.85 <= (width / max(1, height)) <= 1.15):
            symmetrized = True
            for tx in range(fitted_width):
                px = offset_x + tx
                for dy in range((fitted_height + 1) // 2):
                    y1 = offset_y + dy
                    y2 = offset_y + fitted_height - 1 - dy
                    avg_cov = (coverage[y1, px] + coverage[y2, px]) / 2.0
                    coverage[y1, px] = coverage[y2, px] = avg_cov
                    avg_es = (edge_strength[y1, px] + edge_strength[y2, px]) / 2.0
                    edge_strength[y1, px] = edge_strength[y2, px] = avg_es
                    avg_supp = (edge_support[y1, px] + edge_support[y2, px]) / 2.0
                    edge_support[y1, px] = edge_support[y2, px] = avg_supp
                    presence[y1, px] = presence[y2, px] = (presence[y1, px] | presence[y2, px])

        # Neighbor color sampling: eliminate dark tiles on newly symmetrized pixels
        # Rather than leaving newly enabled boundary pixels with dark transparent background,
        # sample color from adjacent in-mask neighbors on the same side, preserving directional shading
        if symmetrized:
            for _ in range(2):
                for py in range(target_h):
                    for px in range(target_w):
                        if coverage[py, px] >= 0.15 and not original_presence[py, px]:
                            valid_nbrs = [
                                material[ny, nx]
                                for nx, ny in _neighbors(px, py, target_w, target_h, diagonal=True)
                                if original_presence[ny, nx] and coverage[ny, nx] >= 0.15
                            ]
                            if valid_nbrs:
                                material[py, px] = np.mean(valid_nbrs, axis=0)
                                original_presence[py, px] = True

    return coverage, material, holes, channels, edge_strength, dominant_ids, component_fraction, edge_support, side_support, presence, (fitted_width, fitted_height), bounds


def _has_component_path(
    x: int,
    y: int,
    component_id: int,
    dominant_ids: np.ndarray,
    component_fraction: np.ndarray,
    presence: np.ndarray,
    mask: np.ndarray,
) -> bool:
    """Check a four-connected target path carrying one source component."""
    height, width = dominant_ids.shape
    allowed = presence & (dominant_ids == component_id) & (component_fraction >= 0.35)
    if not allowed[y, x]:
        return False
    queue: deque[tuple[int, int]] = deque([(x, y)])
    seen = {(x, y)}
    while queue:
        cx, cy = queue.popleft()
        if (cx, cy) != (x, y) and mask[cy, cx]:
            return True
        for nx, ny in _neighbors(cx, cy, width, height, diagonal=False):
            if allowed[ny, nx] and (nx, ny) not in seen:
                seen.add((nx, ny))
                queue.append((nx, ny))
    return False


def _boundary_cells(fitted_size: tuple[int, int], target_size: tuple[int, int], margin: int) -> set[tuple[int, int]]:
    target_w, target_h = target_size
    width, height = fitted_size
    if width <= 0 or height <= 0:
        return set()
    x0, y0 = (target_w - width) // 2, (target_h - height) // 2
    cells = {(x, y) for x in range(x0, x0 + width) for y in (y0, y0 + height - 1)}
    cells.update((x, y) for y in range(y0, y0 + height) for x in (x0, x0 + width - 1))
    return cells


def _promote_edges(
    mask: np.ndarray,
    coverage: np.ndarray,
    holes: np.ndarray,
    channels: np.ndarray,
    edge_strength: np.ndarray,
    dominant_ids: np.ndarray,
    component_fraction: np.ndarray,
    edge_support: np.ndarray,
    side_support: np.ndarray,
    presence: np.ndarray,
    fitted_size: tuple[int, int],
    target_size: tuple[int, int],
    margin: int,
) -> int:
    target_w, target_h = target_size
    promoted = 0
    width, height = fitted_size
    x0, y0 = (target_w - width) // 2, (target_h - height) // 2

    for x, y in sorted(_boundary_cells(fitted_size, target_size, margin)):
        if mask[y, x]:
            continue
        boundary_sides: list[int] = []
        if y == y0:
            boundary_sides.append(0)
        if x == x0 + width - 1:
            boundary_sides.append(1)
        if y == y0 + height - 1:
            boundary_sides.append(2)
        if x == x0:
            boundary_sides.append(3)
        corresponding_edge = max((float(side_support[y, x, side]) for side in boundary_sides), default=0.0)
        if coverage[y, x] < 0.08 or edge_support[y, x] < 0.15 or corresponding_edge < 0.04 or edge_strength[y, x] < 0.20:
            continue
        component_id = int(dominant_ids[y, x])
        if component_id < 1 or component_fraction[y, x] < 0.55 or holes[y, x] >= 0.22 or channels[y, x] >= 0.22:
            continue
        path = _has_component_path(x, y, component_id, dominant_ids, component_fraction, presence, mask)
        endpoint = coverage[y, x] >= 0.30 and edge_strength[y, x] >= 0.70
        if not path and not endpoint:
            continue
        mask[y, x] = True
        promoted += 1
    return promoted


def _component_path_evidence(
    coverage: np.ndarray,
    holes: np.ndarray,
    channels: np.ndarray,
    dominant_ids: np.ndarray,
    component_fraction: np.ndarray,
    presence: np.ndarray,
    source_components: Sequence[dict[str, object]],
) -> np.ndarray:
    """Identify target cells carrying a real, possibly thin source component."""
    if source_components:
        valid_ids = {
            int(component["id"])
            for component in source_components
            if int(component.get("area", 0)) >= 16
        }
    else:
        valid_ids = {int(value) for value in np.unique(dominant_ids) if value > 0}

    if not valid_ids:
        return np.zeros_like(presence, dtype=bool)

    return (
        presence
        & (coverage >= 0.035)
        & (dominant_ids > 0)
        & np.isin(dominant_ids, np.asarray(sorted(valid_ids), dtype=np.int32))
        & (component_fraction >= 0.20)
        & (holes < 0.28)
        & (channels < 0.38)
    )


def _preserve_component_paths(
    mask: np.ndarray,
    coverage: np.ndarray,
    holes: np.ndarray,
    channels: np.ndarray,
    edge_strength: np.ndarray,
    dominant_ids: np.ndarray,
    component_fraction: np.ndarray,
    presence: np.ndarray,
    source_components: Sequence[dict[str, object]],
) -> np.ndarray:
    """Restore connected low-coverage strands without filling negative space."""
    evidence = _component_path_evidence(
        coverage,
        holes,
        channels,
        dominant_ids,
        component_fraction,
        presence,
        source_components,
    )
    if not evidence.any():
        return evidence

    evidence_labels, evidence_components = _label_components(evidence, diagonal=True)
    height, width = mask.shape
    for component in evidence_components:
        component_id = int(component["id"])
        coords = np.argwhere(evidence_labels == component_id)
        if len(coords) < 2:
            continue

        touches_mask = False
        for y, x in coords:
            y_i, x_i = int(y), int(x)
            if mask[y_i, x_i] or any(
                mask[ny, nx]
                for nx, ny in _neighbors(x_i, y_i, width, height, diagonal=True)
            ):
                touches_mask = True
                break
        if not touches_mask:
            continue

        # Restore only sparse evidence. Higher-coverage cells already belong to
        # the normal silhouette grammar; promoting them makes one-pixel strands
        # turn into uneven two-pixel bars.
        for y, x in coords:
            y_i, x_i = int(y), int(x)
            if float(coverage[y_i, x_i]) < 0.16:
                mask[y_i, x_i] = True

    return evidence


def _limit_rim_saturation(color: RGB, max_saturation: Optional[float]) -> RGB:
    """Desaturate dark rim colors while preserving their luminance and hue."""
    if max_saturation is None:
        return color

    limit = float(np.clip(max_saturation, 0.0, 1.0))
    channels = np.asarray(color, dtype=np.float32)
    high = float(np.max(channels))
    low = float(np.min(channels))
    if high <= 1e-6 or high - low <= limit * high:
        return tuple(int(value) for value in color)

    neutral = float(0.299 * channels[0] + 0.587 * channels[1] + 0.114 * channels[2])
    denominator = (high - low) - limit * (high - neutral)
    scale = 0.0 if denominator <= 1e-6 else min(1.0, limit * neutral / denominator)
    adjusted = neutral + (channels - neutral) * scale
    return tuple(int(np.clip(round(float(value)), 0, 255)) for value in adjusted)




def _grammar_mask(
    coverage: np.ndarray,
    holes: np.ndarray,
    channels: np.ndarray,
    edge_strength: np.ndarray,
    dominant_ids: np.ndarray,
    component_fraction: np.ndarray,
    presence: np.ndarray,
    edge_support: np.ndarray,
    side_support: np.ndarray,
    fitted_size: tuple[int, int],
    target_size: tuple[int, int],
    margin: int,
    source_components: Sequence[dict[str, object]] = (),
    is_tile: bool = False,
    softness: float = 0.0,
) -> np.ndarray:
    """Construct binary sprite geometry with topology grammar guarantees."""
    target_w, target_h = target_size
    if is_tile:
        return np.ones((target_h, target_w), dtype=bool)
    mask = coverage >= 0.22

    # Channel and hole carving: protect thin features so fins/tails aren't punctured
    reserved_holes = (holes >= 0.28) & (coverage < 0.52)
    reserved_channels = (channels >= 0.38) & (coverage < 0.20)
    reserved = reserved_holes | reserved_channels
    mask[reserved] = False

    _promote_edges(
        mask, coverage, holes, channels, edge_strength, dominant_ids, component_fraction,
        edge_support, side_support, presence, fitted_size, target_size, margin
    )

    # Component preservation: only promote genuine source components (area >= 16px)
    valid_source_ids = {
        int(c["id"]) for c in source_components
        if int(c.get("area", 0)) >= 16
    } if source_components else set(int(v) for v in np.unique(dominant_ids) if v > 0)

    for component_id in sorted(valid_source_ids):
        represented = np.any(mask & (dominant_ids == component_id) & (component_fraction >= 0.45))
        if represented:
            continue
        candidates: list[tuple[float, int, int]] = []
        for y, x in zip(*np.where(presence & (dominant_ids == component_id) & (component_fraction >= 0.45) & ~reserved)):
            if holes[y, x] >= 0.22 or channels[y, x] >= 0.22:
                continue
            candidates.append((float(coverage[y, x] + 0.20 * edge_strength[y, x]), int(y), int(x)))
        if candidates:
            _, y, x = max(candidates, key=lambda item: (item[0], -item[1], -item[2]))
            mask[y, x] = True

    # The strand/bridge rules inspect y±1 and x±1; keep their scan away from
    # the canvas edge even when outline_mode="none" sets margin to zero.
    interior_y_start = max(1, margin)
    interior_y_stop = min(target_h - 1, target_h - margin)
    interior_x_start = max(1, margin)
    interior_x_stop = min(target_w - 1, target_w - margin)

    # Bridge filling: joins occupied cells of the same component across single gaps
    for _ in range(2):
        for y in range(interior_y_start, interior_y_stop):
            for x in range(interior_x_start, interior_x_stop):
                if mask[y, x] or reserved[y, x] or coverage[y, x] < 0.12:
                    continue
                candidate_id = int(dominant_ids[y, x])
                if candidate_id < 1 or component_fraction[y, x] < 0.45 or holes[y, x] >= 0.18 or channels[y, x] >= 0.18:
                    continue
                four = [(nx, ny) for nx, ny in _neighbors(x, y, target_w, target_h, diagonal=False) if mask[ny, nx]]
                diagonal = [(nx, ny) for nx, ny in _neighbors(x, y, target_w, target_h, diagonal=True) if abs(nx - x) == 1 and abs(ny - y) == 1 and mask[ny, nx]]
                neighbour_ids = [int(dominant_ids[ny, nx]) for nx, ny in four + diagonal]
                same_four = sum(value == candidate_id for value in neighbour_ids[: len(four)])
                same_diagonal = sum(value == candidate_id for value in neighbour_ids[len(four) :])
                horizontal = (x > 0 and mask[y, x - 1] and int(dominant_ids[y, x - 1]) == candidate_id) and (
                    x + 1 < target_w and mask[y, x + 1] and int(dominant_ids[y, x + 1]) == candidate_id
                )
                vertical = (y > 0 and mask[y - 1, x] and int(dominant_ids[y - 1, x]) == candidate_id) and (
                    y + 1 < target_h and mask[y + 1, x] and int(dominant_ids[y + 1, x]) == candidate_id
                )
                if (horizontal or vertical) and same_four >= 2 and (same_four + same_diagonal) >= 3:
                    mask[y, x] = True

    # Thin-strand and delicate feature bridge filling (heals necklaces, webs, diagonal chains, staves)
    # Protected by hole/channel checks so it never bridges across open bow cavities or negative space
    for _ in range(1):
        for y in range(interior_y_start, interior_y_stop):
            for x in range(interior_x_start, interior_x_stop):
                if (
                    mask[y, x]
                    or reserved[y, x]
                    or holes[y, x] >= 0.15
                    or channels[y, x] >= 0.20
                    or coverage[y, x] < 0.08
                    or not presence[y, x]
                ):
                    continue
                has_ns = mask[y - 1, x] and mask[y + 1, x]
                has_ew = mask[y, x - 1] and mask[y, x + 1]
                has_diag1 = mask[y - 1, x - 1] and mask[y + 1, x + 1]
                has_diag2 = mask[y - 1, x + 1] and mask[y + 1, x - 1]
                has_turn = (
                    (mask[y - 1, x] and mask[y, x + 1]) or
                    (mask[y - 1, x] and mask[y, x - 1]) or
                    (mask[y + 1, x] and mask[y, x + 1]) or
                    (mask[y + 1, x] and mask[y, x - 1])
                ) and coverage[y, x] >= 0.16 and holes[y, x] < 0.08
                if (has_ns or has_ew or has_diag1 or has_diag2) and coverage[y, x] >= 0.08:
                    mask[y, x] = True
                elif has_turn:
                    mask[y, x] = True

    # Notch filling: fills 3-neighbor concave corners
    for y in range(interior_y_start, interior_y_stop):
        for x in range(interior_x_start, interior_x_stop):
            if mask[y, x] or reserved[y, x] or coverage[y, x] < 0.34:
                continue
            four = [(nx, ny) for nx, ny in _neighbors(x, y, target_w, target_h, diagonal=False) if mask[ny, nx]]
            if len(four) >= 3:
                mask[y, x] = True

    # Softness check: prune rough 2x2 corner doubles along diagonal contours of soft/curved shapes
    if softness >= 0.65:
        for y in range(target_h - 1):
            for x in range(target_w - 1):
                window = mask[y:y+2, x:x+2]
                if np.sum(window) == 3:
                    coords = [(y, x), (y, x+1), (y+1, x), (y+1, x+1)]
                    empty_idx = [i for i, (cy, cx) in enumerate(coords) if not mask[cy, cx]][0]
                    corner_idx = 3 - empty_idx
                    cy, cx = coords[corner_idx]
                    exterior_count = sum(not mask[ny, nx] for nx, ny in _neighbors(cx, cy, width=target_w, height=target_h, diagonal=True))
                    if exterior_count >= 3 and coverage[cy, cx] < 0.40:
                        other_indices = [i for i in range(4) if i != empty_idx and i != corner_idx]
                        o1_y, o1_x = coords[other_indices[0]]
                        o2_y, o2_x = coords[other_indices[1]]
                        o1_conns = sum(mask[ny, nx] for nx, ny in _neighbors(o1_x, o1_y, target_w, target_h, diagonal=True) if (ny, nx) not in coords)
                        o2_conns = sum(mask[ny, nx] for nx, ny in _neighbors(o2_x, o2_y, target_w, target_h, diagonal=True) if (ny, nx) not in coords)
                        if o1_conns >= 1 and o2_conns >= 1:
                            mask[cy, cx] = False

    # Isolated pixel pruning: removes single orphan pixels lacking coverage support
    for y in range(target_h):
        for x in range(target_w):
            if not mask[y, x]:
                continue
            four = [(nx, ny) for nx, ny in _neighbors(x, y, target_w, target_h, diagonal=False) if mask[ny, nx]]
            diagonal = [(nx, ny) for nx, ny in _neighbors(x, y, target_w, target_h, diagonal=True) if abs(nx - x) == 1 and abs(ny - y) == 1 and mask[ny, nx]]
            if len(four) == 0 and len(diagonal) == 0:
                mask[y, x] = False
            elif len(four) == 0 and len(diagonal) == 1 and coverage[y, x] < 0.12 and not presence[y, x]:
                mask[y, x] = False

    # Restore connected source strands after the smoothing passes. The evidence
    # mask is deliberately conservative, so open bow cavities and necklace gaps
    # remain negative space rather than being filled by morphology.
    _preserve_component_paths(
        mask,
        coverage,
        holes,
        channels,
        edge_strength,
        dominant_ids,
        component_fraction,
        presence,
        source_components,
    )

    return mask


# ==============================================================================
# 3. Out-of-Bounds Aware Contour Detection
# ==============================================================================

def _contour(mask: np.ndarray) -> np.ndarray:
    """Detect boundary pixels, evaluating out-of-bounds canvas borders as exterior background.

    Fixes the boundary contour bug where border-touching pixels failed to receive outlines.
    """
    height, width = mask.shape
    contour = np.zeros(mask.shape, dtype=bool)
    for y in range(height):
        for x in range(width):
            if not mask[y, x]:
                continue
            # If on canvas edge, it borders the outside world
            if x == 0 or x == width - 1 or y == 0 or y == height - 1:
                contour[y, x] = True
                continue
            # Check 4-connected in-bounds neighbors
            if any(not mask[ny, nx] for nx, ny in _neighbors(x, y, width, height, diagonal=False)):
                contour[y, x] = True
    return contour


# ==============================================================================
# 4. Non-Destructive Material Rim (from V5, without interior detail loss)
# ==============================================================================

def _apply_material_rim(
    pixels: np.ndarray,
    mask: np.ndarray,
    contour: np.ndarray,
    outline_darken: float = 0.55,
    max_rim_colors: int = 3,
    preserve_emissives: bool = True,
    max_rim_saturation: Optional[float] = None,
    palette: Optional[Sequence[RGB]] = None,
) -> None:
    """Darken boundary pixels using the sprite's material palette.

    Allocates up to max_rim_colors dedicated rim colors. Leaves interior pixels
    100% untouched and darkens each material border without flattening its hue.
    When a palette is supplied, rim anchors are selected from it and snapped to
    the same coarse color steps, preventing post-quantization color drift.
    """
    height, width = mask.shape
    boundary_coords = list(zip(*np.nonzero(contour & mask)))
    if not boundary_coords:
        return

    def rim_color(anchor: np.ndarray, factor: float) -> RGB:
        anchor_rgb = np.asarray(anchor, dtype=np.float32)
        if palette:
            palette_anchor = min(
                palette,
                key=lambda color: float(np.sum((anchor_rgb - np.asarray(color, dtype=np.float32)) ** 2)),
            )
            anchor_rgb = np.asarray(palette_anchor, dtype=np.float32)
        scaled = np.clip(anchor_rgb * factor, 0.0, 255.0)
        if palette:
            scaled = np.round(scaled / 8.0) * 8.0
        return tuple(int(np.clip(round(float(value)), 0, 255)) for value in scaled)

    candidates: list[RGB] = []
    active_coords: list[tuple[int, int]] = []

    for y, x in boundary_coords:
        curr_rgb = pixels[y, x, :3]
        if preserve_emissives:
            # Emissive highlights: candle flames, sparkles, bright glints
            is_flame_white = curr_rgb[0] >= 210 and curr_rgb[1] >= 190 and curr_rgb[2] >= 150
            is_flame_gold = (
                curr_rgb[0] >= 230
                and curr_rgb[1] >= 150
                and curr_rgb[2] < 120
                and int(curr_rgb[0]) - int(curr_rgb[1]) >= 48
            )
            is_specular = curr_rgb[0] >= 245 and curr_rgb[1] >= 245 and curr_rgb[2] >= 245
            if is_flame_white or is_flame_gold or is_specular:
                continue

        # Sample 5x5 interior neighborhood
        interior_samples: list[RGB] = []
        for ny in range(max(0, y - 2), min(height, y + 3)):
            for nx in range(max(0, x - 2), min(width, x + 3)):
                if mask[ny, nx] and not contour[ny, nx]:
                    interior_samples.append(tuple(int(c) for c in pixels[ny, nx, :3]))

        if interior_samples:
            anchor = np.median(np.asarray(interior_samples), axis=0)
            darkened = rim_color(anchor, outline_darken)
        else:
            # Thin 1-2px feature with no interior pixels: gentle rim so limbs/shoes retain material tones
            anchor = pixels[y, x, :3].astype(np.float32)
            darkened = rim_color(anchor, max(0.80, outline_darken))
            pixels[y, x, :3] = _limit_rim_saturation(darkened, max_rim_saturation)
            continue
        darkened = _limit_rim_saturation(darkened, max_rim_saturation)
        candidates.append(darkened)
        active_coords.append((y, x))

    if not candidates:
        return

    # Cluster candidates into up to max_rim_colors dedicated rim palette
    unique_candidates = sorted(set(candidates))
    if len(unique_candidates) <= max_rim_colors:
        rim_palette = unique_candidates
    else:
        # Simple k-means / median split for rim candidates
        ordered = sorted(unique_candidates, key=lambda c: (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114))
        step = len(ordered) / float(max_rim_colors)
        rim_palette = [ordered[int(i * step)] for i in range(max_rim_colors)]

    for (y, x), candidate in zip(active_coords, candidates):
        best_rim = min(
            rim_palette,
            key=lambda rc: (rc[0] - candidate[0]) ** 2 + (rc[1] - candidate[1]) ** 2 + (rc[2] - candidate[2]) ** 2
        )
        pixels[y, x, :3] = best_rim


def apply_inner_border(
    image: Image.Image,
    outline_darken: float = 0.70,
    preserve_emissives: bool = True,
    max_rim_colors: int = 4,
    max_rim_saturation: Optional[float] = None,
) -> Image.Image:
    """Apply a non-destructive material inner border to an RGBA sprite.

    Darkens boundary pixels along the transparent edge using the adjacent interior
    material color. Designed for props (factor ~0.70) to prevent bleeding into matching
    floors, while being softer than UI item borders (~0.55).
    """
    rgba = np.array(image.convert("RGBA")).copy()
    mask = rgba[..., 3] > 64
    if not mask.any():
        return image
    contour = _contour(mask)
    _apply_material_rim(
        rgba,
        mask,
        contour,
        outline_darken=outline_darken,
        max_rim_colors=max_rim_colors,
        preserve_emissives=preserve_emissives,
        max_rim_saturation=max_rim_saturation,
    )
    return Image.fromarray(rgba, mode="RGBA")


# ==============================================================================
# 5. Content-Aware Adaptive Palette Allocator & Selective Vibrance
# ==============================================================================

def _apply_selective_vibrance(materials: np.ndarray, vibrance: float = 0.35) -> np.ndarray:
    """Apply non-linear selective vibrance curve to RGB [0..255] float array.

    Protects neutrals (S ~ 0) and saturated colors (S ~ 1). Boosts washed-out midtones
    (leathers, shields, weathered metals) without global multiplier blowout.
    """
    rgb_f = materials.astype(np.float32) / 255.0
    max_c = np.max(rgb_f, axis=-1)
    min_c = np.min(rgb_f, axis=-1)
    delta = max_c - min_c

    s = np.where(max_c > 1e-4, delta / np.maximum(max_c, 1e-4), 0.0)
    v = max_c

    # Smooth bell-shaped vibrance lift peaking at S ~ 0.35-0.45
    # Zero at S=0, zero at S=1
    boost = vibrance * (1.0 - s) * np.sin(np.pi * s)
    s_new = np.clip(s + boost, 0.0, 1.0)

    # Scale chroma: new_delta = s_new * v
    scale = np.where(delta > 1e-4, (s_new * v) / np.maximum(delta, 1e-4), 1.0)

    # RGB centered around max_c
    rgb_new = max_c[..., None] - (max_c[..., None] - rgb_f) * scale[..., None]
    return np.clip(rgb_new * 255.0, 0.0, 255.0)


def _apply_pixel_palette_style(
    materials: np.ndarray,
    active_mask: np.ndarray,
    *,
    contrast: float = 1.15,
    saturation: float = 1.15,
    hue_shift_degrees: float = 4.0,
    min_luminance_span: float = 0.24,
    exposure: float = 1.0,
    highlight_compression: float = 0.45,
) -> np.ndarray:
    """Expand a sprite's own color gamut into a readable pixel-art ramp.

    This is deliberately per-sprite rather than a shared palette pass. It
    stretches compressed value ranges, lifts low-key materials, compresses
    saturated highlights, and nudges dark tones cooler than highlights.
    Neutral materials remain neutral.
    """
    styled = materials.astype(np.float32, copy=True)
    active = np.asarray(active_mask, dtype=bool)
    if not np.any(active):
        return styled

    selected = styled[active]
    luma_weights = np.asarray((0.2126, 0.7152, 0.0722), dtype=np.float32)
    source_luma = (selected @ luma_weights) / 255.0
    source_low, source_high = (float(value) for value in np.percentile(source_luma, (8.0, 92.0)))
    source_span = max(source_high - source_low, 1e-4)

    source_rgb = selected / 255.0
    source_max = np.max(source_rgb, axis=-1)
    source_min = np.min(source_rgb, axis=-1)
    source_saturation = np.where(
        source_max > 1e-4,
        (source_max - source_min) / np.maximum(source_max, 1e-4),
        0.0,
    )

    # Preserve the source ordering, but guarantee enough value separation for
    # a readable three-tone ramp even when the input is a muddy dark crop.
    target_low = max(0.035, source_low * 0.90)
    target_span = max(source_span * max(1.0, float(contrast)), float(min_luminance_span))
    target_high = min(0.98, max(source_high * 1.15, target_low + target_span))

    # Range expansion alone leaves low-key materials dark. Add exposure only
    # below a high-value threshold so bright gems and potions are not lifted.
    low_key_amount = float(np.clip((0.62 - source_high) / 0.62, 0.0, 1.0))
    target_high = min(
        0.98,
        target_high + low_key_amount * 0.32 * max(0.0, float(exposure)),
    )
    target_span = max(target_high - target_low, 1e-4)
    tone = np.clip((source_luma - source_low) / source_span, 0.0, 1.0)
    target_luma = target_low + tone * target_span

    # Compress the luminance of already-bright saturated colors slightly. This
    # keeps yellow/gold highlights vivid without turning them into white-yellow.
    bright_tone = np.clip((target_luma - 0.68) / 0.24, 0.0, 1.0)
    saturated_tone = np.clip((source_saturation - 0.55) / 0.45, 0.0, 1.0)
    highlight_reduction = (
        max(0.0, float(highlight_compression))
        * 0.12
        * bright_tone
        * saturated_tone
    )
    target_luma = np.maximum(target_low, target_luma - highlight_reduction)

    # Scale around black instead of adding a gray offset; this preserves the
    # hue of dark materials while opening up their value range.
    scale = target_luma / np.maximum(source_luma, 0.015)
    styled_selected = np.clip(selected * scale[:, None], 0.0, 255.0)

    # Chroma is expanded around luminance, but high-value saturated colors
    # receive a smaller gain so yellows retain gold/orange middle tones instead
    # of clipping red and green to the same maximum channel.
    styled_luma = styled_selected @ luma_weights
    sat_gain = max(0.0, float(saturation))
    per_pixel_sat_gain = np.maximum(0.85, sat_gain - highlight_reduction * 0.35)
    styled_selected = styled_luma[:, None] + (
        styled_selected - styled_luma[:, None]
    ) * per_pixel_sat_gain[:, None]
    styled_selected = np.clip(styled_selected, 0.0, 255.0)
    # Keep high-chroma highlights below a hard channel clip. Applying this
    # after saturation shaping is important because scaling a yellow source
    # channel before this point can already have reached 255.
    max_channel = np.max(styled_selected, axis=-1)
    max_cap = 255.0 * (
        1.0
        - 0.10
        * max(0.0, float(highlight_compression))
        * bright_tone
        * saturated_tone
    )
    cap_scale = np.minimum(1.0, max_cap / np.maximum(max_channel, 1e-4))
    styled_selected = np.clip(styled_selected * cap_scale[:, None], 0.0, 255.0)

    # A small tone-dependent hue rotation gives ramps a hand-authored feel
    # without changing the material family. Skip near-neutrals deliberately.
    hue_shift = float(hue_shift_degrees)
    if abs(hue_shift) > 1e-4:
        for index, color in enumerate(styled_selected):
            high = float(np.max(color))
            low = float(np.min(color))
            if high <= 1e-4 or (high - low) / high < 0.08:
                continue
            red, green, blue = (float(channel) / 255.0 for channel in color)
            hue, sat, value = colorsys.rgb_to_hsv(red, green, blue)
            hue = (hue + hue_shift * (1.5 * float(tone[index]) - 1.0) / 360.0) % 1.0
            styled_selected[index] = np.asarray(colorsys.hsv_to_rgb(hue, sat, value), dtype=np.float32) * 255.0

    styled[active] = styled_selected
    return np.clip(styled, 0.0, 255.0)


def _hue_family(rgb: RGB) -> str:
    """Classify RGB into a material hue family or neutral."""
    r, g, b = (float(c) / 255.0 for c in rgb)
    high, low = max(r, g, b), min(r, g, b)
    chroma = high - low
    lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    if lum <= 50.0 and (max(rgb) - min(rgb)) <= 24:
        return "contour"
    if chroma <= 0.12:
        return "neutral"
    if high == r:
        hue = 60.0 * ((g - b) / chroma % 6.0)
    elif high == g:
        hue = 60.0 * ((b - r) / chroma + 2.0)
    else:
        hue = 60.0 * ((r - g) / chroma + 4.0)
    hue %= 360.0
    return f"hue_{int((hue + 22.5) // 45.0) % 8}"


def allocate_adaptive_palette(
    image_rgb: np.ndarray,
    mask: np.ndarray,
    min_colors: int = 4,
    max_colors: int = 16,
    tones_per_material: int = 3,
    variance_threshold: float = 45.0,
    split: str = "range",
) -> list[RGB]:
    """Dynamically determine optimal palette size and extract colors without artificial banding.

    A simple brown sphere receives ~4 colors; a complex rainbow receives up to max_colors.
    """
    pixels = image_rgb[mask]
    if pixels.size == 0:
        return [HARD_NAVY_OUTLINE]

    # Count frequency of each material family
    family_counts: Counter[str] = Counter()
    for p in pixels:
        family_counts[_hue_family(tuple(int(c) for c in p))] += 1

    total_pixels = max(1, len(pixels))
    # Keep families representing at least 5% of the sprite
    significant_families = {f for f, cnt in family_counts.items() if (cnt / total_pixels) >= 0.05}
    if not significant_families:
        significant_families = set(family_counts.keys())

    needed_colors = len(significant_families) * tones_per_material + 1
    target_count = max(min_colors, min(max_colors, needed_colors))

    # Median-cut quantization with perceptual variance stopping
    counts = Counter(tuple(int(c) for c in p) for p in pixels)
    boxes: list[list[tuple[RGB, int]]] = [list(counts.items())]

    while len(boxes) < target_count:
        # Find box with highest color variance
        best_box_idx = -1
        max_variance = -1.0
        for idx, box in enumerate(boxes):
            if len(box) < 2:
                continue
            if split == "variance":
                # pixel-weighted squared error: a large region with a real tonal spread (an iron
                # plate) outranks a few outlying highlight colours (a flame's hot core)
                cols = np.array([c for c, _ in box], np.float64)
                w = np.array([n for _, n in box], np.float64)
                spread = max(float(cols[:, ch].max() - cols[:, ch].min()) for ch in range(3))
                if spread < variance_threshold:
                    continue
                mean = (cols * w[:, None]).sum(0) / w.sum()
                v = float((((cols - mean) ** 2).sum(1) * w).sum())
                if v > max_variance:
                    max_variance = v
                    best_box_idx = idx
                continue
            for ch in range(3):
                vals = [c[ch] for c, _ in box]
                v = max(vals) - min(vals)
                if v > max_variance:
                    max_variance = v
                    best_box_idx = idx

        if best_box_idx < 0 or (split != "variance" and max_variance < variance_threshold):
            # All clusters have negligible variance; stop splitting to avoid artificial micro-bands!
            break

        box = boxes.pop(best_box_idx)
        # Split along channel with maximum span
        split_ch = max(
            range(3),
            key=lambda c: max(item[0][c] for item in box) - min(item[0][c] for item in box)
        )
        box.sort(key=lambda item: item[0][split_ch])
        halfway = sum(cnt for _, cnt in box) / 2.0
        running = 0
        split_point = 1
        for i, (_, cnt) in enumerate(box[:-1], start=1):
            running += cnt
            if running >= halfway:
                split_point = i
                break
        boxes.append(box[:split_point])
        boxes.append(box[split_point:])

    # Extract weighted mean color from each cluster box
    palette: list[RGB] = []
    for box in boxes:
        total_weight = sum(cnt for _, cnt in box)
        if total_weight > 0:
            mean_c = tuple(
                int(round(sum(c[ch] * cnt for c, cnt in box) / float(total_weight)))
                for ch in range(3)
            )
            # Snap to step 8
            snapped = tuple(int(round(v / 8.0) * 8) for v in mean_c)
            palette.append((min(255, max(0, snapped[0])), min(255, max(0, snapped[1])), min(255, max(0, snapped[2]))))

    return list(dict.fromkeys(palette)) or [HARD_NAVY_OUTLINE]
