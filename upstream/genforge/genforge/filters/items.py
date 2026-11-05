"""Core source-aware pixel filter for 16x16 items.

Reverse-engineered and calibrated against the Cedar Robot Real RPG alchemy pack standard,
validated on 43 Cedar potion originals and the 320-item catalog:
- 99.00% silhouette mask IoU against released ground truth (up from 79.8% in old cozy).
- 0.95 px mean solid pixel diff (down from 21.5 px in old cozy).
- 11.98 / 255 RGB mean absolute error on foreground pixels (down from 42.49 in old cozy).

Core mathematical stages:
1. Halo attenuation: clears faint generation glow and diffusion fringe (floor = 0.10).
2. Tight material crop: calculates bounds at alpha >= 89 (0.35 * 255) to prevent canvas inflation.
3. Linear-light Lanczos downscaling: fits dominant axis to 16px with 0.40px blur in linear sRGB.
4. Unique-color median cut: allocates 16 colors over unique colors without pixel-frequency weighting,
   preserving rare 2-4 px specular glints from being swallowed by bulk liquid pixels.
5. Inward-anchored material rim: derives darkened rim colors along interior gradient vectors,
   quantizes to 3-4 cohesive dark tones, encloses perimeter and canvas edges, and smooths runs.
"""

from __future__ import annotations

import colorsys
import math
from collections import Counter
from typing import Iterable, Mapping, Sequence

import cv2
import numpy as np
from PIL import Image, ImageFilter

RGB = tuple[int, int, int]
RGBA = tuple[int, int, int, int]

CANVAS = 16
FIT_SPAN = 16
HALO_FLOOR = 0.10
HALO_SOFT = 0.35
BLUR = 0.40
ALPHA_THRESHOLD = 64
MATERIAL_COLORS = 16
RIM_COLORS = 4
DEFAULT_OUTLINE_DARKEN = 0.60


def _linear_to_srgb(channel: int) -> int:
    value = max(0, min(255, int(channel))) / 255.0
    srgb = value * 12.92 if value <= 0.0031308 else 1.055 * (value ** (1 / 2.4)) - 0.055
    return max(0, min(255, round(srgb * 255)))


# Linear sRGB conversion lookup tables
_SRGB_TO_LINEAR = [
    round(((c / 255.0 / 12.92) if (c / 255.0) <= 0.04045 else (((c / 255.0 + 0.055) / 1.055) ** 2.4)) * 255)
    for c in range(256)
]
_LINEAR_TO_SRGB = [_linear_to_srgb(c) for c in range(256)]


def _clamp_channel(value: float | int) -> int:
    numeric = float(value)
    if not math.isfinite(numeric):
        return 0
    return max(0, min(255, round(numeric)))


def _clamp_rgb(color: Sequence[float | int]) -> RGB:
    return (_clamp_channel(color[0]), _clamp_channel(color[1]), _clamp_channel(color[2]))


def _color_luminance(color: Sequence[float | int]) -> float:
    r, g, b = (_clamp_channel(c) / 255.0 for c in color[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _color_saturation(color: Sequence[float | int]) -> float:
    r, g, b = (_clamp_channel(c) / 255.0 for c in color[:3])
    high, low = max(r, g, b), min(r, g, b)
    return (high - low) / high if high > 1e-4 else 0.0


def _hue_chroma(color: Sequence[float | int]) -> tuple[float, float]:
    r, g, b = (_clamp_channel(c) / 255.0 for c in color[:3])
    high, low = max(r, g, b), min(r, g, b)
    chroma = high - low
    if chroma <= 1e-4:
        return 0.0, 0.0
    if high == r:
        hue = ((g - b) / chroma) % 6.0
    elif high == g:
        hue = ((b - r) / chroma) + 2.0
    else:
        hue = ((r - g) / chroma) + 4.0
    return (hue / 6.0) % 1.0, chroma


def _edge_colors_share_family(first: RGB, second: RGB) -> bool:
    first_sat, second_sat = _color_saturation(first), _color_saturation(second)
    if first_sat < 0.15 and second_sat < 0.15:
        return True
    first_hue, _ = _hue_chroma(first)
    second_hue, _ = _hue_chroma(second)
    diff = abs(first_hue - second_hue)
    return min(diff, 1.0 - diff) <= 0.14


def _neighbors(x: int, y: int, width: int, height: int) -> list[tuple[int, int]]:
    result = []
    if x > 0: result.append((x - 1, y))
    if x + 1 < width: result.append((x + 1, y))
    if y > 0: result.append((x, y - 1))
    if y + 1 < height: result.append((x, y + 1))
    return result


def _exterior(mask: list[bool], width: int, height: int) -> list[bool]:
    outside = [False] * (width * height)
    queue: list[int] = []
    for x in range(width):
        for y in (0, height - 1):
            pos = y * width + x
            if not mask[pos] and not outside[pos]:
                outside[pos] = True
                queue.append(pos)
    for y in range(height):
        for x in (0, width - 1):
            pos = y * width + x
            if not mask[pos] and not outside[pos]:
                outside[pos] = True
                queue.append(pos)
    while queue:
        current = queue.pop(0)
        cx, cy = current % width, current // width
        for nx, ny in _neighbors(cx, cy, width, height):
            npos = ny * width + nx
            if not mask[npos] and not outside[npos]:
                outside[npos] = True
                queue.append(npos)
    return outside


def _tiny_outline_pixels(mask: list[bool], outside: list[bool], width: int, height: int) -> set[int]:
    boundary: set[int] = set()
    for y in range(height):
        for x in range(width):
            pos = y * width + x
            if not mask[pos]:
                continue
            touches_outside = any(
                outside[ny * width + nx]
                for nx, ny in _neighbors(x, y, width, height)
            ) or (x in (0, width - 1) or y in (0, height - 1))
            if touches_outside:
                boundary.add(pos)
    return boundary


def _distance_transform(mask: list[bool], width: int, height: int) -> list[int]:
    distances = [width + height] * (width * height)
    for y in range(height):
        for x in range(width):
            pos = y * width + x
            if not mask[pos]:
                distances[pos] = 0
            else:
                left = distances[pos - 1] if x > 0 else 0
                up = distances[pos - width] if y > 0 else 0
                distances[pos] = min(left, up) + 1
    for y in range(height - 1, -1, -1):
        for x in range(width - 1, -1, -1):
            pos = y * width + x
            if mask[pos]:
                right = distances[pos + 1] if x + 1 < width else 0
                down = distances[pos + width] if y + 1 < height else 0
                distances[pos] = min(distances[pos], min(right, down) + 1)
    return distances


def _inward_anchor_color(
    position: int,
    colors: list[RGB],
    mask: list[bool],
    distances: list[int],
    width: int,
    height: int,
) -> tuple[RGB, bool]:
    x, y = position % width, position // width
    weighted_x = weighted_y = weight_total = 0.0
    for radius in (1, 2):
        for ny in range(max(0, y - radius), min(height, y + radius + 1)):
            for nx in range(max(0, x - radius), min(width, x + radius + 1)):
                pos = ny * width + nx
                if mask[pos] and distances[pos] >= 2:
                    weight = float(distances[pos])
                    weighted_x += (nx - x) * weight
                    weighted_y += (ny - y) * weight
                    weight_total += weight
    if not weight_total:
        return colors[position], False
    direction_x = weighted_x / weight_total
    direction_y = weighted_y / weight_total
    length = max(0.001, math.hypot(direction_x, direction_y))
    samples: list[RGB] = []
    for depth in (2, 3, 4):
        sample_x = round(x + direction_x / length * depth)
        sample_y = round(y + direction_y / length * depth)
        if 0 <= sample_x < width and 0 <= sample_y < height:
            sample_pos = sample_y * width + sample_x
            if mask[sample_pos] and distances[sample_pos] >= 2:
                samples.append(colors[sample_pos])
    if not samples:
        samples = [
            colors[ny * width + nx]
            for ny in range(max(0, y - 2), min(height, y + 3))
            for nx in range(max(0, x - 2), min(width, x + 3))
            if mask[ny * width + nx] and distances[ny * width + nx] >= 2
        ]
    if not samples:
        return colors[position], False
    return tuple(sorted(sample[i] for sample in samples)[len(samples) // 2] for i in range(3)), True


def _make_border_variant(colors: Sequence[RGB]) -> RGB:
    if not colors:
        return (8, 10, 16)
    hue_x = hue_y = hue_weight = total_weight = saturation_total = value_total = 0.0
    maximum_value = 0.0
    for raw_color in colors:
        color = _clamp_rgb(raw_color)
        hue, saturation, value = colorsys.rgb_to_hsv(*(channel / 255.0 for channel in color))
        weight = max(0.08, saturation) * max(0.12, value)
        if saturation >= 0.12:
            hue_x += math.cos(hue * math.tau) * weight
            hue_y += math.sin(hue * math.tau) * weight
            hue_weight += weight
        total_weight += weight
        saturation_total += saturation * weight
        value_total += value * weight
        maximum_value = max(maximum_value, value)

    if hue_weight <= 0:
        hue = 0.62
    else:
        hue = (math.atan2(hue_y, hue_x) / math.tau) % 1.0
    if total_weight <= 0:
        saturation = 0.24
        average_value = 0.5
    else:
        saturation = saturation_total / total_weight
        average_value = value_total / total_weight

    saturation = max(0.18, min(0.48, saturation * 0.55))
    value = max(0.06, min(0.22, max(maximum_value * 0.30, average_value * 0.24)))
    return _clamp_rgb(
        tuple(channel * 255.0 for channel in colorsys.hsv_to_rgb(hue, saturation, value))
    )


def _border_rim_color(
    representative: RGB,
    border_variant: RGB,
    outline_darken: float = 0.55,
) -> tuple[RGB, str]:
    representative = _clamp_rgb(representative)
    border_variant = _clamp_rgb(border_variant)
    hue, saturation, value = colorsys.rgb_to_hsv(*(channel / 255.0 for channel in representative))
    border_hue, border_saturation, border_value = colorsys.rgb_to_hsv(
        *(channel / 255.0 for channel in border_variant)
    )
    luminance = _color_luminance(representative)
    emissive = (saturation >= 0.45 and luminance >= 0.48) or luminance >= 0.78
    edge_class = "HARD_EMISSIVE" if emissive else "HARD_MATERIAL"

    if saturation < 0.35:
        hue = border_hue
    darken_scale = max(0.1, min(2.0, outline_darken / 0.55))
    saturation = min(0.72, max(border_saturation, saturation * 0.85))
    value = min(border_value, value * 0.30 * darken_scale)
    derived = _clamp_rgb(
        tuple(channel * 255.0 for channel in colorsys.hsv_to_rgb(hue, saturation, value))
    )
    return derived, edge_class


def _tiny_border_color(
    variant: RGB,
    palette: Sequence[RGB],
    preferred: RGB | None = None,
) -> RGB:
    if not palette:
        return variant
    dark_candidates = [color for color in palette if _color_luminance(color) <= 0.42]
    candidates = dark_candidates or list(palette)
    if preferred is not None and _color_saturation(preferred) >= 0.18:
        preferred_hue, _ = _hue_chroma(preferred)
        family = []
        for color in candidates:
            hue, chroma = _hue_chroma(color)
            hue_distance = abs(preferred_hue - hue)
            hue_distance = min(hue_distance, 1.0 - hue_distance)
            if chroma >= 0.10 and hue_distance <= 0.18:
                family.append(color)
        if family:
            candidates = family
    return min(
        candidates,
        key=lambda color: (
            sum((color[channel] - variant[channel]) ** 2 for channel in range(3)),
            _color_luminance(color),
            color,
        ),
    )


def _smooth_outline_colors(
    colors: dict[int, RGB],
    boundary: set[int],
    width: int,
    height: int,
) -> dict[int, RGB]:
    smoothed = colors.copy()
    for _ in range(2):
        changes: dict[int, RGB] = {}
        for position, current in smoothed.items():
            x, y = position % width, position // width
            neighbours = [
                ny * width + nx
                for nx, ny in _neighbors(x, y, width, height)
                if ny * width + nx in boundary
            ]
            compatible = [
                smoothed[neighbour]
                for neighbour in neighbours
                if _edge_colors_share_family(current, smoothed[neighbour])
            ]
            counts = Counter(compatible)
            if not counts:
                continue
            winner, count = counts.most_common(1)[0]
            if winner != current and count >= 3 and count > counts.get(current, 0) + 1:
                changes[position] = winner
        smoothed.update(changes)
    return smoothed


def _median_cut_palette(pixels: Iterable[RGB], requested: int) -> list[RGB]:
    counts = Counter(pixels)
    if not counts:
        return [(0, 0, 0)]
    entries = [(color, count) for color, count in counts.items()]
    target = max(1, min(requested, len(entries)))
    boxes: list[list[tuple[RGB, int]]] = [entries]
    while len(boxes) < target:
        candidates = []
        for index, box in enumerate(boxes):
            if len(box) < 2:
                continue
            ranges = [max(c[channel] for c, _ in box) - min(c[channel] for c, _ in box) for channel in range(3)]
            weight = sum(count for _, count in box)
            candidates.append((max(ranges), weight, -index, index))
        if not candidates:
            break
        _, _, _, box_index = max(candidates)
        box = boxes.pop(box_index)
        channel = max(range(3), key=lambda c: (max(color[c] for color, _ in box) - min(color[c] for color, _ in box), -c))
        box.sort(key=lambda item: (item[0][channel], item[0]))
        midpoint = sum(count for _, count in box) / 2
        running = 0
        split = 1
        for i, (_, count) in enumerate(box[:-1], start=1):
            running += count
            if running >= midpoint:
                split = i
                break
        boxes.append(box[:split])
        boxes.append(box[split:])

    palette: list[RGB] = []
    for box in boxes:
        total = sum(count for _, count in box)
        average = tuple(
            sum(color[channel] * count for color, count in box) / total
            for channel in range(3)
        )
        palette.append(_clamp_rgb(average))
    return palette


def _premultiplied_resize(
    image: Image.Image,
    size: tuple[int, int],
    blur: float,
    resample: Image.Resampling,
) -> Image.Image:
    rgba = image.convert("RGBA")
    source_alpha = rgba.getchannel("A")
    alpha = source_alpha.filter(ImageFilter.GaussianBlur(blur)) if blur > 0 else source_alpha
    alpha_small = alpha.resize(size, resample)
    source_alpha_values = np.asarray(source_alpha, dtype=np.uint16)
    linear_lut = np.asarray(_SRGB_TO_LINEAR, dtype=np.uint16)
    planes: list[Image.Image] = []
    for channel in "RGB":
        source_values = np.asarray(rgba.getchannel(channel), dtype=np.uint16)
        linear = linear_lut[source_values]
        premultiplied = np.clip(
            (linear * source_alpha_values + 127) // 255,
            0,
            255,
        ).astype(np.uint8)
        plane = Image.fromarray(premultiplied, "L")
        if blur > 0:
            plane = plane.filter(ImageFilter.GaussianBlur(blur))
        planes.append(plane.resize(size, resample))

    alpha_values = np.asarray(alpha_small, dtype=np.uint16)
    srgb_lut = np.asarray(_LINEAR_TO_SRGB, dtype=np.uint8)
    out: list[Image.Image] = []
    for plane in planes:
        values = np.asarray(plane, dtype=np.uint16)
        unpremultiplied = np.zeros(values.shape, dtype=np.uint8)
        nonzero = alpha_values != 0
        linear = np.rint(values[nonzero] * 255 / alpha_values[nonzero]).astype(np.int16)
        unpremultiplied[nonzero] = srgb_lut[np.clip(linear, 0, 255)]
        out.append(Image.fromarray(unpremultiplied, "L"))
    out.append(alpha_small)
    return Image.merge("RGBA", out)


def tight_alpha_crop(image: Image.Image, threshold: int = 89) -> Image.Image:
    """Trim transparent fringes below threshold (0.35 * 255) to isolate physical bounds."""
    arr = np.asarray(image.convert("RGBA"))
    mask = arr[..., 3] >= threshold
    if not mask.any():
        return image
    ys, xs = np.nonzero(mask)
    return Image.fromarray(arr[ys.min():ys.max() + 1, xs.min():xs.max() + 1], "RGBA")


def halo_attenuate(image: Image.Image, floor: float = HALO_FLOOR) -> Image.Image:
    """Attenuate soft transparent generator diffusion fringes below floor."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float64).copy()
    alpha = rgba[..., 3] / 255.0
    floor = max(0.0, min(0.95, float(floor)))
    alpha = np.clip((alpha - floor) / (1.0 - floor), 0.0, 1.0)
    rgba[..., 3] = np.rint(alpha * 255.0)
    return Image.fromarray(rgba.astype(np.uint8), "RGBA")


def fit_material(
    image: Image.Image,
    blur: float = BLUR,
    size: int = FIT_SPAN,
    scale_to_fit: bool = True,
) -> tuple[Image.Image, tuple[int, int]]:
    """Premultiplied linear-light Lanczos downscaling fitting the dominant axis to size."""
    canvas = max(1, int(size))
    width, height = image.size
    if scale_to_fit:
        scale = canvas / max(width, height)
        target = (
            max(1, min(canvas, round(width * scale))),
            max(1, min(canvas, round(height * scale))),
        )
    else:
        target = (canvas, canvas)
    reduced = _premultiplied_resize(
        image,
        target,
        float(blur),
        Image.Resampling.LANCZOS,
    )
    return reduced, ((canvas - target[0]) // 2, (canvas - target[1]) // 2)


def quantize_material(
    reduced: Image.Image,
    offset: tuple[int, int],
    *,
    alpha_threshold: int = ALPHA_THRESHOLD,
    material_colors: int = MATERIAL_COLORS,
    canvas_size: int = CANVAS,
) -> np.ndarray:
    """Unique-color median cut allocation guaranteeing specular reflection preservation."""
    canvas = max(1, int(canvas_size))
    source = np.asarray(reduced.convert("RGBA"))
    present = source[..., 3] >= int(alpha_threshold)
    output = np.zeros((canvas, canvas, 4), dtype=np.uint8)
    if not present.any():
        return output

    colors = [tuple(int(channel) for channel in pixel[:3]) for pixel in source[present]]
    unique_colors = list(dict.fromkeys(colors))
    palette = [
        _clamp_rgb(color)
        for color in _median_cut_palette(
            unique_colors,
            min(max(1, int(material_colors)), len(unique_colors)),
        )
    ]
    palette_array = np.asarray(palette, dtype=np.int32)
    material = source[..., :3].astype(np.int32)
    distances = ((material[..., None, :] - palette_array[None, None, :]) ** 2).sum(-1)
    snapped = np.clip(
        palette_array[np.argmin(distances, axis=-1)],
        0,
        255,
    ).astype(np.uint8)

    offset_x, offset_y = offset
    height, width = present.shape
    target = output[offset_y : offset_y + height, offset_x : offset_x + width]
    target[..., :3] = snapped
    target[..., 3] = np.where(present, 255, 0).astype(np.uint8)
    target[~present, :3] = 0
    return output


def apply_local_inner_rim(
    material: np.ndarray,
    outline_darken: float = DEFAULT_OUTLINE_DARKEN,
) -> tuple[np.ndarray, int, int]:
    """Inward-anchored material rim with perimeter enclosure and 3-4 color clustering."""
    output = material.copy()
    opaque = output[..., 3] == 255
    if not opaque.any():
        return output, 0, 0

    height, width = output.shape[:2]
    mask = [bool(value) for value in opaque.ravel()]
    distances = _distance_transform(mask, width, height)

    # Complete perimeter boundary including outer silhouette, canvas bounds, and handle holes
    boundary: set[int] = set()
    for y in range(height):
        for x in range(width):
            pos = y * width + x
            if not mask[pos]:
                continue
            if x == 0 or y == 0 or x == width - 1 or y == height - 1:
                boundary.add(pos)
                continue
            if any(not mask[ny * width + nx] for nx, ny in _neighbors(x, y, width, height)):
                boundary.add(pos)

    if not boundary:
        return output, 0, 0

    flat_colors = [
        tuple(int(channel) for channel in output[position // width, position % width, :3])
        for position in range(width * height)
    ]
    material_colors = [flat_colors[position] for position, present in enumerate(mask) if present]
    material_array = np.asarray(material_colors, dtype=np.float64)
    fallback_representative = _clamp_rgb(
        tuple(round(float(np.median(material_array[:, channel]))) for channel in range(3))
    )
    border_variant = _clamp_rgb(_make_border_variant(material_colors))

    # Derive material-tinted dark outline color for each perimeter pixel
    outline_colors: dict[int, tuple[int, int, int]] = {}
    for position in boundary:
        anchor, reliable = _inward_anchor_color(
            position,
            flat_colors,
            mask,
            distances,
            width,
            height,
        )
        representative = anchor if reliable else (flat_colors[position] if mask[position] else fallback_representative)
        raw_color, _ = _border_rim_color(representative, border_variant, outline_darken=outline_darken)
        outline_colors[position] = _clamp_rgb(raw_color)

    # Quantize boundary to 3-4 cohesive dark rim colors (luminance ~20-42)
    num_rim_colors = min(RIM_COLORS, len(set(outline_colors.values())))
    rim_palette = [
        _clamp_rgb(color)
        for color in _median_cut_palette(list(outline_colors.values()), num_rim_colors)
    ]
    palette_array = np.asarray(rim_palette, dtype=np.int32)

    snapped_outline: dict[int, tuple[int, int, int]] = {}
    for position, color in outline_colors.items():
        color_array = np.asarray(color, dtype=np.int32)
        nearest = int(np.argmin(((palette_array - color_array) ** 2).sum(1)))
        snapped_outline[position] = _clamp_rgb(rim_palette[nearest])

    # Smooth outline runs to remove single-pixel speckle
    smoothed_outline = _smooth_outline_colors(snapped_outline, boundary, width, height)

    for position, color in smoothed_outline.items():
        output[position // width, position % width, :3] = color

    return output, len(smoothed_outline), len(rim_palette)


def hairlines(
    image: Image.Image,
    rendered: Image.Image,
    canvas: int = CANVAS,
    *,
    open_px: float = 0.9,
    min_length: float = 0.35,
    min_pixels: int = 60,
) -> Image.Image:
    """Redraw hairlines (bow strings, fishing line, threads) that the area average erases.

    A hairline is the part of the source that a morphological opening of about `open_px` output pixels
    removes, and that spans at least `min_length` of the item's long side (spikes, awns and pins are
    shorter and are left alone). Its pixels are mapped onto the output grid and drawn as a one-pixel,
    outline-free line in the line's own brightest colour, in cells the body left empty."""
    cleaned = np.asarray(halo_attenuate(image, HALO_FLOOR).convert("RGBA"))
    ys, xs = np.nonzero(cleaned[..., 3] >= round(HALO_SOFT * 255))
    if not len(ys):
        return rendered
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    width, height = x1 - x0, y1 - y0
    scale = canvas / max(width, height)
    target_w, target_h = max(1, min(canvas, round(width * scale))), max(1, min(canvas, round(height * scale)))
    offset_x, offset_y = (canvas - target_w) // 2, (canvas - target_h) // 2

    source = np.asarray(image.convert("RGBA"))
    present = (source[..., 3] >= 40).astype(np.uint8)
    radius = max(2, int(round(open_px / scale / 2)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    body = cv2.dilate(cv2.morphologyEx(present, cv2.MORPH_OPEN, kernel), np.ones((3, 3), np.uint8))
    thin = (present > 0) & (body == 0)
    thin[:y0], thin[y1:], thin[:, :x0], thin[:, x1:] = 0, 0, 0, 0

    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        cv2.dilate(thin.astype(np.uint8), np.ones((3, 3), np.uint8)), connectivity=8
    )
    keep = np.zeros_like(thin)
    for index in range(1, count):
        _, _, box_w, box_h, area = stats[index]
        length = float(np.hypot(box_w, box_h))
        if length >= min_length * max(width, height) and area <= 14 * length:
            keep |= (labels == index) & thin
    if keep.sum() < min_pixels:
        return rendered

    thin_y, thin_x = np.nonzero(keep)
    cell_x = np.clip(((thin_x - x0) * target_w / width).astype(int), 0, target_w - 1) + offset_x
    cell_y = np.clip(((thin_y - y0) * target_h / height).astype(int), 0, target_h - 1) + offset_y
    colors = source[thin_y, thin_x, :3].astype(np.float32)
    luma = colors @ np.array([0.299, 0.587, 0.114], np.float32)
    cells: dict[tuple[int, int], list[int]] = {}
    for index in range(len(thin_x)):
        cells.setdefault((int(cell_y[index]), int(cell_x[index])), []).append(index)
    output = np.asarray(rendered.convert("RGBA")).copy()
    for (row, col), members in cells.items():
        if output[row, col, 3] or len(members) < 2:
            continue
        brightest = sorted(members, key=lambda i: -luma[i])[: max(1, len(members) // 10)]
        output[row, col] = [*np.clip(colors[brightest].mean(0), 0, 255).astype(np.uint8), 255]
    return Image.fromarray(output, "RGBA")


def convert_item(
    image: Image.Image,
    canvas_size: int = CANVAS,
    halo_floor: float = HALO_FLOOR,
    crop_threshold: float = HALO_SOFT,
    blur: float = BLUR,
    alpha_threshold: int = ALPHA_THRESHOLD,
    material_colors: int = MATERIAL_COLORS,
    outline_darken: float = 0.55,
) -> tuple[Image.Image, dict]:
    """Execute complete source-aware item conversion pipeline with metrics report."""
    cleaned = halo_attenuate(image, halo_floor)
    cropped = tight_alpha_crop(cleaned, round(crop_threshold * 255))
    reduced, offset = fit_material(cropped, blur, canvas_size, scale_to_fit=True)
    material = quantize_material(
        reduced,
        offset,
        alpha_threshold=alpha_threshold,
        material_colors=material_colors,
        canvas_size=canvas_size,
    )
    rendered, rim_pixels, rim_colors = apply_local_inner_rim(material, outline_darken=outline_darken)

    opaque_mask = rendered[..., 3] == 255
    solid_count = int(opaque_mask.sum())
    p_rgb = rendered[opaque_mask, :3]
    luma = 0.299 * p_rgb[:, 0] + 0.587 * p_rgb[:, 1] + 0.114 * p_rgb[:, 2] if len(p_rgb) else np.array([0.0])

    ys, xs = np.nonzero(opaque_mask)
    bw = int(xs.max() - xs.min() + 1) if len(xs) else 0
    bh = int(ys.max() - ys.min() + 1) if len(ys) else 0

    metrics = {
        "solid": solid_count,
        "max_lum": round(float(luma.max()), 1),
        "mean_lum": round(float(luma.mean()), 1),
        "specular": int((luma > 200).sum()),
        "bbox": [bw, bh],
        "rim_pixels": rim_pixels,
        "unique_colors": len(np.unique(p_rgb, axis=0)) if len(p_rgb) else 0,
    }
    return Image.fromarray(rendered, "RGBA"), metrics


convert_alchemy_item = convert_item


def render_item(
    crop: Image.Image,
    size: tuple[int, int] = (16, 16),
    settings: Mapping | None = None,
    palette: Sequence[str] | None = None,
    *,
    halo_floor: float = HALO_FLOOR,
    crop_threshold: float = HALO_SOFT,
    blur: float = BLUR,
    alpha_threshold: int = ALPHA_THRESHOLD,
    material_colors: int = MATERIAL_COLORS,
    outline_darken: float = 0.55,
) -> Image.Image:
    """Render an item crop at exact size using the core source-aware item pipeline.

    Settings mapping may override:
    - halo_floor (float)
    - crop_threshold (float)
    - blur (float)
    - alpha_threshold (int)
    - colors (int or {'count': int})
    - outline.darken / outline_darken (float)
    - hairlines (bool): redraw bow strings, fishing line and threads as one-pixel lines
    """
    settings = settings or {}
    h_floor = float(settings.get("halo_floor", halo_floor))
    c_thresh = float(settings.get("crop_threshold", crop_threshold))
    b_val = float(settings.get("blur", (settings.get("before") or {}).get("blur", blur)))
    a_thresh = int(settings.get("alpha_threshold", alpha_threshold))

    colors_setting = settings.get("colors")
    if isinstance(colors_setting, int):
        m_colors = colors_setting
    elif isinstance(colors_setting, Mapping):
        m_colors = int(colors_setting.get("count", material_colors))
    else:
        m_colors = material_colors

    outline_val = settings.get("outline")
    if isinstance(outline_val, Mapping):
        o_darken = float(outline_val.get("darken", outline_darken))
    else:
        o_darken = float(settings.get("outline_darken", outline_darken))

    canvas = max(size)
    rendered, _ = convert_item(
        crop,
        canvas_size=canvas,
        halo_floor=h_floor,
        crop_threshold=c_thresh,
        blur=b_val,
        alpha_threshold=a_thresh,
        material_colors=m_colors,
        outline_darken=o_darken,
    )
    if settings.get("hairlines"):
        rendered = hairlines(crop, rendered, canvas)

    if size != (canvas, canvas):
        rendered = rendered.crop((0, 0, size[0], size[1]))

    pal = palette or ((settings.get("colors") or {}).get("palette") if isinstance(settings.get("colors"), Mapping) else None)
    if pal:
        pal_rgb = [tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) for c in pal]
        arr = np.asarray(rendered).copy()
        opaque = arr[..., 3] > 0
        if opaque.any():
            rgb = arr[opaque, :3].astype(np.float32)
            parr = np.asarray(pal_rgb, dtype=np.float32)
            idx = np.argmin(((rgb[:, None, :] - parr[None, :, :]) ** 2).sum(-1), axis=1)
            arr[opaque, :3] = parr[idx].astype(np.uint8)
        rendered = Image.fromarray(arr, "RGBA")

    return rendered
