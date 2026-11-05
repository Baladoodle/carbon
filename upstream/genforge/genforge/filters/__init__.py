"""The pixel filter (PLAN §4.6, M4): a subject crop → a sprite of an exact size.

`render(crop, size, settings, palette)` is the one entry point. Every setting is optional; the
stages run in this order:

    before      blur and sharpen on the source; the grading (contrast, saturation, hue_shift,
                exposure, highlights, span) on the pooled grid, tuned for pixel-art ramps
    downscale   `edge_preserving` (default): pooling that keeps thin parts, holes and gaps, then a
                one-pixel grid decision per cell (the proven core of `render_pixel_art`);
                `nearest`, `area`, `median`: plain resampling, the mask by alpha coverage;
                `item`: the whole 16x16 item path (`items.py`: halo attenuation, linear-light fit,
                unique-colour median cut, inward-anchored rim), which replaces the later stages;
                only `colors.count`, `outline.darken`, `hairlines` and a set palette apply. Tested
                at 16x16 only; every other size or kind keeps `edge_preserving` unless set up
    hairlines   with `downscale: item`: bow strings, fishing line and threads as one-pixel lines
    vibrance    selective saturation of the dull colours, before quantising
    colors      `count` colours picked from the sprite (`pick`: `range` or `variance` split),
                or exactly the given palette; every pixel mapped to its nearest colour
    dither      `ordered` (Bayer 4×4) or `diffusion` (Floyd–Steinberg), with `strength`
    noise       `amount`: a seeded share of pixels moved one palette step lighter or darker
    outline     `none`, `inner` (contour darkened), `hard` (contour in one colour), `rim` (contour
                darkened per material, emissives kept), `outer` (a ring outside the silhouette);
                with a set palette, outline shades snap back onto it (the palette is exact)
    cleanup     `stray`: lone pixels take their neighbours' colour; `min_cluster`; `symmetry`
    alpha       a threshold (fraction) for the silhouette, or `smooth` (coverage as alpha)

Vibrance runs before the colours (not last, as PLAN §4.6 listed it) so the final pixels stay on
the palette. With `settings=None` (the `clean` style) it resamples and applies an explicitly
supplied palette, preserving the resampled alpha.
"""

from __future__ import annotations

import hashlib
from typing import Mapping, Sequence

import numpy as np
from PIL import Image, ImageFilter

from . import topology as legacy
from . import items
from .items import convert_alchemy_item, convert_item, render_item
from ..imaging import resample

DEFAULT_OUTLINE = (24, 32, 48)
BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32) / 16 - 0.5


def render(crop: Image.Image, size: tuple[int, int], settings: Mapping | None,
           palette: Sequence[str] | None = None) -> Image.Image:
    """The crop at exactly `size`, through the stages `settings` enables."""
    if settings is None:
        image = resample(crop, size)
        if palette:
            image = Image.fromarray(_snap(np.array(image.convert("RGBA")), [_hex(c) for c in palette]))
        return image
    if _mode(settings, "downscale", "") in ("item", "source_aware"):
        return items.render_item(crop, size, settings, palette)
    return Image.fromarray(run(crop, size, settings, palette)["pixels"])


def render_family(images: Mapping[str, Image.Image], size: tuple[int, int], settings: Mapping | None,
                  palette: Sequence[str] | None = None) -> dict[str, Image.Image]:
    """Aligned members use the same sampling phase and palette, with outlines confined to each canvas."""
    if not images:
        return {}
    if len({image.size for image in images.values()}) != 1:
        raise ValueError("a filter family needs aligned images on one source canvas")
    return render_batch(images, {name: size for name in images}, settings, palette)


def render_batch(images: Mapping[str, Image.Image], sizes: Mapping[str, tuple[int, int]], settings: Mapping | None,
                 palette: Sequence[str] | None = None) -> dict[str, Image.Image]:
    """A palette shared by differently sized sprites, with independent fitting and sampling."""
    if not images:
        return {}
    if settings is None:
        return {name: render(image, sizes[name], None, palette) for name, image in images.items()}
    prepared = {name: _prepare(image, sizes[name], settings) for name, image in images.items()}
    materials = np.concatenate([item[2].reshape(-1, 3) for item in prepared.values()])[None]
    masks = np.concatenate([item[1].ravel() for item in prepared.values()])[None]
    colours = _palette(materials, masks, settings, palette)
    return {name: Image.fromarray(_finish(images[name], sizes[name], settings, palette, item, colours)["pixels"])
            for name, item in prepared.items()}


def palette_for_batch(images: Mapping[str, Image.Image], sizes: Mapping[str, tuple[int, int]], settings: Mapping) -> list[str]:
    """Choose the family palette from fitted sprites rather than background or discarded sheet pixels."""
    if not images:
        return ["#%02x%02x%02x" % DEFAULT_OUTLINE]
    prepared = [_prepare(image, sizes[name], settings) for name, image in images.items()]
    materials = np.concatenate([item[2].reshape(-1, 3) for item in prepared])[None]
    masks = np.concatenate([item[1].ravel() for item in prepared])[None]
    return ["#%02x%02x%02x" % color for color in _palette(materials, masks, settings, None)]


def _mode(settings: Mapping, stage: str, default: str) -> str:
    """A stage written as `stage: mode` or `stage: {mode|method: …}`."""
    v = settings.get(stage)
    if isinstance(v, Mapping):
        return v.get("mode", v.get("method", default))
    return default if v is None else v


def _param(settings: Mapping, stage: str, key: str, default=None):
    v = settings.get(stage)
    return v.get(key, default) if isinstance(v, Mapping) else default


def _hex(c: str) -> tuple[int, int, int]:
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def run(crop: Image.Image, size: tuple[int, int], settings: Mapping, palette: Sequence[str] | None = None) -> dict:
    """Every stage, with its intermediate data: {pixels, mask, palette, stages: {name: data}}."""
    prepared = _prepare(crop, size, settings)
    colours = _palette(prepared[2], prepared[1], settings, palette)
    return _finish(crop, size, settings, palette, prepared, colours)


def _prepare(crop: Image.Image, size: tuple[int, int], settings: Mapping):
    img = crop.convert("RGBA")
    stages: dict = {}
    outline = _outline_mode(settings)
    w, h = size
    inset = 1 if outline == "outer" and min(size) > 2 else 0
    grid = (max(1, w - 2 * inset), max(1, h - 2 * inset))

    img = _before(img, settings.get("before") or {})
    cleanup = settings.get("cleanup") or {}
    mask, materials, data = _downscale(img, grid, settings, symmetry=bool(cleanup.get("symmetry", False)))
    stages["downscale"] = data
    before = settings.get("before") or {}
    grade = {k: before[k] for k in ("contrast", "saturation", "hue_shift", "exposure", "highlights", "span") if k in before}
    if grade:
        materials = legacy._apply_pixel_palette_style(
            materials, mask, contrast=grade.get("contrast", 1.0), saturation=grade.get("saturation", 1.0),
            hue_shift_degrees=grade.get("hue_shift", 0.0),
            min_luminance_span=grade.get("span", 0.0), exposure=grade.get("exposure", 1.0),
            highlight_compression=grade.get("highlights", 0.0))
    vib = _amount(settings.get("vibrance"))
    if vib:
        materials = legacy._apply_selective_vibrance(materials, vib)
    return img, mask, materials, stages, inset


def _finish(crop, size, settings, palette, prepared, colours):
    img, mask, materials, stages, inset = prepared
    w, h = size
    grid = (max(1, w - 2 * inset), max(1, h - 2 * inset))
    outline = _outline_mode(settings)
    cleanup = settings.get("cleanup") or {}
    stages["colors"] = {"count": len(colours)}
    index = _map(materials, mask, colours, settings)
    index = _noise(index, mask, colours, _amount(settings.get("noise")), crop)
    pixels = np.zeros((grid[1], grid[0], 4), np.uint8)
    pixels[mask, :3] = np.array(colours, np.uint8)[index[mask]]
    pixels[mask, 3] = 255

    if inset:
        pad = np.zeros((h, w, 4), np.uint8)
        pad[inset:inset + grid[1], inset:inset + grid[0]] = pixels
        pixels = pad
        m2 = np.zeros((h, w), bool)
        m2[inset:inset + grid[1], inset:inset + grid[0]] = mask
        mask = m2
    pixels, mask = _outline(pixels, mask, outline, settings, colours)
    pixels = _cleanup(pixels, mask, cleanup)
    if palette or (isinstance(settings.get("colors"), Mapping) and settings["colors"].get("palette")):
        pixels = _snap(pixels, colours)      # a set palette is exact (§4.5): outline shades snap back onto it
    pixels = _alpha(pixels, mask, settings.get("alpha"), img, size, inset)
    return {"pixels": pixels, "mask": mask, "palette": colours, "stages": stages}


def _snap(pixels: np.ndarray, colours: list[tuple]) -> np.ndarray:
    """Every opaque pixel to its nearest palette colour."""
    pal = np.array(colours, np.float32)
    on = pixels[..., 3] > 0
    rgb = pixels[on][:, :3].astype(np.float32)
    idx = np.argmin(((rgb[:, None, :] - pal[None, :, :]) ** 2).sum(-1), axis=1)
    out = pixels.copy()
    out[on, :3] = pal[idx].astype(np.uint8)
    return out


def _amount(v) -> float:
    if isinstance(v, Mapping):
        v = v.get("amount", 0)
    return float(v or 0)


def _before(img: Image.Image, before: Mapping) -> Image.Image:
    if not any(k in before for k in ("blur", "sharpen")):
        return img
    alpha = img.getchannel("A")
    rgb = img.convert("RGB")
    if before.get("blur"):
        rgb = rgb.filter(ImageFilter.GaussianBlur(float(before["blur"])))
    if before.get("sharpen"):
        rgb = rgb.filter(ImageFilter.UnsharpMask(radius=2, percent=int(100 * float(before["sharpen"])), threshold=2))
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def _downscale(img: Image.Image, grid: tuple[int, int], settings: Mapping, symmetry: bool):
    method = _mode(settings, "downscale", "edge_preserving")
    a = np.asarray(img)
    threshold = _alpha_threshold(settings.get("alpha"))
    if method == "edge_preserving":
        solid = a[..., 3] >= threshold
        if not solid.any():
            return np.zeros(grid[::-1], bool), np.zeros(grid[::-1] + (3,), np.float32), {"method": method, "empty": True}
        labels, components = legacy._label_components(solid, diagonal=True)
        empty, _, holes_ids, channel_ids = legacy._negative_space(solid)
        hole_mask = np.isin(empty, np.asarray(sorted(holes_ids), np.int32))
        channel_mask = np.isin(empty, np.asarray(sorted(channel_ids), np.int32))
        (coverage, materials, holes, channels, edge, dominant, fraction, edge_support, side_support, presence,
         fitted, _) = legacy._pool_source(a, solid, labels, hole_mask, channel_mask, target_size=grid, margin=0,
                                          is_tile=False, anchor_mode="bottom", symmetry=symmetry,
                                          fit_bounds=(0, 0, a.shape[1], a.shape[0]),
                                          coverage_from_mask=settings.get("alpha") == "smooth")
        perimeter = float(legacy._contour(solid).sum())
        softness = 4.0 * np.pi * float(solid.sum()) / max(1.0, perimeter ** 2)
        mask = legacy._grammar_mask(coverage, holes, channels, edge, dominant, fraction, presence, edge_support,
                                    side_support, fitted_size=fitted, target_size=grid, margin=0,
                                    source_components=components, is_tile=False, softness=softness)
        if symmetry:
            mask = _symmetric(mask, solid)
        return mask, materials.astype(np.float32), {"method": method, "softness": round(softness, 4)}
    if method in ("item", "source_aware"):
        cleaned = items.halo_attenuate(img, float(settings.get("halo_floor", items.HALO_FLOOR)))
        cropped = items.tight_alpha_crop(cleaned, round(float(settings.get("crop_threshold", items.HALO_SOFT)) * 255))
        blur = float(settings.get("blur", (settings.get("before") or {}).get("blur", items.BLUR)))
        canvas = max(grid)
        reduced, offset = items.fit_material(cropped, blur, canvas, scale_to_fit=True)
        colors_spec = settings.get("colors")
        m_colors = int(colors_spec.get("count", items.MATERIAL_COLORS)) if isinstance(colors_spec, Mapping) else int(colors_spec or items.MATERIAL_COLORS)
        quant = items.quantize_material(
            reduced,
            offset,
            alpha_threshold=threshold,
            material_colors=m_colors,
            canvas_size=canvas,
        )
        if grid != (canvas, canvas):
            quant = quant[:grid[1], :grid[0]]
        mask = quant[..., 3] >= threshold
        if symmetry:
            mask = _symmetric(mask, a[..., 3] >= threshold)
        return mask, quant[..., :3].astype(np.float32), {"method": method}
    resample_with = {"nearest": Image.NEAREST, "area": Image.BOX, "median": Image.BOX}[method]
    small = img.resize(grid, resample_with)
    if method == "median":
        small = _median(img, grid, threshold)
    s = np.asarray(small)
    mask = s[..., 3] >= threshold
    if symmetry:
        mask = _symmetric(mask, a[..., 3] >= threshold)
    return mask, s[..., :3].astype(np.float32), {"method": method}


def _median(img: Image.Image, grid: tuple[int, int], threshold: int = 128) -> Image.Image:
    a = np.asarray(img).astype(np.float32)
    H, W = a.shape[:2]
    out = np.zeros((grid[1], grid[0], 4), np.uint8)
    ys = np.linspace(0, H, grid[1] + 1).astype(int)
    xs = np.linspace(0, W, grid[0] + 1).astype(int)
    for j in range(grid[1]):
        for i in range(grid[0]):
            cell = a[ys[j]:max(ys[j + 1], ys[j] + 1), xs[i]:max(xs[i + 1], xs[i] + 1)].reshape(-1, 4)
            out[j, i, 3] = np.uint8(cell[:, 3].mean())
            solid = cell[(cell[:, 3] > 0) & (cell[:, 3] >= threshold)]
            if len(solid):
                out[j, i, :3] = np.median(solid[:, :3], axis=0).astype(np.uint8)
    return Image.fromarray(out)


def _symmetric(mask: np.ndarray, source: np.ndarray) -> np.ndarray:
    """Mirror the silhouette when the source is near-symmetric left-right (items: swords, potions)."""
    ys, xs = np.nonzero(source)
    if not len(xs):
        return mask
    s = source[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    f = np.fliplr(s)
    score = 2.0 * (s & f).sum() / max(1, s.sum() + f.sum())
    return mask | np.fliplr(mask) if score >= 0.88 else mask


def _palette(materials: np.ndarray, mask: np.ndarray, settings: Mapping, palette: Sequence[str] | None) -> list[tuple]:
    colors = settings.get("colors")
    given = palette or (colors.get("palette") if isinstance(colors, Mapping) else None)
    if given:
        return [_hex(c) for c in given]
    count = colors if isinstance(colors, int) else (colors or {}).get("count", 16)
    pick = (colors or {}).get("pick", "range") if isinstance(colors, Mapping) else "range"
    split = "variance" if pick == "variance" else "range"
    if not mask.any():
        return [DEFAULT_OUTLINE]
    return [tuple(int(v) for v in c) for c in legacy.allocate_adaptive_palette(
        materials, mask, min_colors=min(4, count), max_colors=count, tones_per_material=3, split=split)]


def _map(materials: np.ndarray, mask: np.ndarray, colours: list[tuple], settings: Mapping) -> np.ndarray:
    """Nearest palette colour per pixel (RGB distance), with optional dithering."""
    pal = np.array(colours, np.float32)
    mode = _mode(settings, "dither", "none")
    strength = float(_param(settings, "dither", "strength", 1.0))
    h, w = mask.shape
    if mode == "diffusion":
        work = materials.astype(np.float32).copy()
        out = np.zeros((h, w), np.int32)
        for y in range(h):
            for x in range(w):
                if not mask[y, x]:
                    continue
                c = work[y, x]
                i = int(np.argmin(((pal - c) ** 2).sum(1)))
                out[y, x] = i
                err = (c - pal[i]) * strength
                for dx, dy, f in ((1, 0, 7 / 16), (-1, 1, 3 / 16), (0, 1, 5 / 16), (1, 1, 1 / 16)):
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < w and yy < h and mask[yy, xx]:
                        work[yy, xx] += err * f
        return out
    src = materials.astype(np.float32)
    if mode == "ordered":
        spread = np.median(np.abs(np.diff(np.sort(pal.mean(1))))) if len(pal) > 1 else 0.0
        t = BAYER4[np.arange(h)[:, None] % 4, np.arange(w)[None, :] % 4]
        src = src + (t * spread * strength)[..., None]
    d = ((src[:, :, None, :] - pal[None, None, :, :]) ** 2).sum(-1)
    return np.argmin(d, axis=-1).astype(np.int32)


def _noise(index: np.ndarray, mask: np.ndarray, colours: list[tuple], amount: float, crop: Image.Image) -> np.ndarray:
    """Move a seeded share of pixels one step along the palette's lightness order (stays on palette)."""
    if amount <= 0 or len(colours) < 2:
        return index
    seed = int.from_bytes(hashlib.sha256(np.asarray(crop).tobytes()).digest()[:8], "little")
    rng = np.random.default_rng(seed)
    order = np.argsort([0.299 * r + 0.587 * g + 0.114 * b for r, g, b in colours])
    rank = np.empty_like(order)
    rank[order] = np.arange(len(order))
    pick = mask & (rng.random(mask.shape) < amount)
    step = rng.choice([-1, 1], size=mask.shape)
    r = np.clip(rank[index] + step, 0, len(colours) - 1)
    out = index.copy()
    out[pick] = order[r[pick]]
    return out


def _outline_mode(settings: Mapping) -> str:
    return _mode(settings, "outline", "none")


def _outline(pixels: np.ndarray, mask: np.ndarray, mode: str, settings: Mapping, colours: list[tuple]):
    if mode == "none" or not mask.any():
        return pixels, mask
    colour = _param(settings, "outline", "color")
    rgb = _hex(colour) if isinstance(colour, str) and colour.startswith("#") else None
    contour = legacy._contour(mask)
    if mode == "outer":
        ring = _dilate(mask) & ~mask
        pixels[ring, :3] = rgb or min(colours, key=lambda c: sum(c))
        pixels[ring, 3] = 255
        return pixels, mask | ring
    if mode == "hard":
        pixels[contour, :3] = rgb or DEFAULT_OUTLINE
    elif mode == "inner":
        darken = float(_param(settings, "outline", "darken", 0.6))
        pixels[contour, :3] = (pixels[contour, :3].astype(np.float32) * darken).astype(np.uint8)
    elif mode == "rim":
        darken = float(_param(settings, "outline", "darken", 0.6))
        legacy._apply_material_rim(pixels, mask, contour, outline_darken=darken, max_rim_colors=3,
                                   preserve_emissives=True, max_rim_saturation=None, palette=colours)
    else:
        raise ValueError(f"unknown outline mode {mode!r}")
    return pixels, mask


def _dilate(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    out[1:] |= mask[:-1]; out[:-1] |= mask[1:]
    out[:, 1:] |= mask[:, :-1]; out[:, :-1] |= mask[:, 1:]
    return out


def _cleanup(pixels: np.ndarray, mask: np.ndarray, cleanup: Mapping) -> np.ndarray:
    """Lone pixels (no 4-neighbour of the same colour) take their most common neighbour colour;
    `min_cluster` does the same for same-colour clusters smaller than it."""
    minimum = int(cleanup.get("min_cluster", 2 if cleanup.get("stray") else 0) or 0)
    if minimum < 2:
        return pixels
    h, w = mask.shape
    key = (pixels[..., 0].astype(np.int64) << 16) | (pixels[..., 1].astype(np.int64) << 8) | pixels[..., 2]
    seen = np.zeros(mask.shape, bool)
    out = pixels.copy()
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or seen[y, x]:
                continue
            stack, cluster = [(y, x)], []
            seen[y, x] = True
            while stack:
                cy, cx = stack.pop()
                cluster.append((cy, cx))
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx] and key[ny, nx] == key[y, x]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if len(cluster) >= minimum:
                continue
            around: dict[int, int] = {}
            for cy, cx in cluster:
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and key[ny, nx] != key[y, x]:
                        around[key[ny, nx]] = around.get(key[ny, nx], 0) + 1
            if around:
                best = max(sorted(around), key=lambda k: around[k])
                for cy, cx in cluster:
                    out[cy, cx, :3] = ((best >> 16) & 255, (best >> 8) & 255, best & 255)
    return out


def _alpha_threshold(alpha) -> int:
    if alpha == "smooth":
        return 1
    return int(round(float(alpha) * 255)) if isinstance(alpha, (int, float)) and not isinstance(alpha, bool) else 128


def _alpha(pixels: np.ndarray, mask: np.ndarray, alpha, img: Image.Image, size: tuple[int, int], inset: int) -> np.ndarray:
    """Binary silhouette by default; `smooth` keeps the source's coverage as alpha inside it."""
    if alpha != "smooth":
        return pixels
    cover = np.asarray(img.getchannel("A").resize((size[0] - 2 * inset, size[1] - 2 * inset), Image.BOX))
    a = pixels[..., 3].copy()
    a[inset:size[1] - inset, inset:size[0] - inset] = np.where(
        mask[inset:size[1] - inset, inset:size[0] - inset], np.maximum(cover, 1), 0)
    out = pixels.copy()
    out[..., 3] = np.where(pixels[..., 3] > 0, np.maximum(a, 0), 0)
    return out
