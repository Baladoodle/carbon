"""Prepare portable, inspectable plans without making a provider call."""
from pathlib import Path

from PIL import Image

from .files import canonical, digest, write_json
from .provider import DEFAULT_MODEL
from .walls import draft, layout, prompts

PRESETS = {
    "item": {"downscale": "item", "colors": {"count": 16}, "hairlines": True},
    "sprite": {"downscale": "edge_preserving", "colors": {"count": 16, "pick": "variance"}, "outline": "rim"},
    "texture": {"downscale": "area", "colors": {"count": 16, "pick": "variance"}, "outline": "none"},
    "none": None,
}


def dimensions(value):
    try:
        width, height = map(int, value.lower().split("x"))
    except (ValueError, AttributeError):
        raise ValueError("Size must be WIDTHxHEIGHT") from None
    if not (1 <= width <= 4096 and 1 <= height <= 4096):
        raise ValueError("Dimensions must be between 1 and 4096")
    return width, height


def check_canvas(size):
    width, height = size
    if (max(size) > 3840 or width % 16 or height % 16 or max(size) > min(size) * 3
            or not 655360 <= width * height <= 8294400):
        raise ValueError("Provider canvas must use multiples of 16, edges <=3840, aspect <=3:1 and 655360–8294400 pixels")


def new_directory(root):
    root.mkdir(parents=True, exist_ok=False)
    (root / "inputs").mkdir()
    (root / "sources").mkdir()


def copy_image(root, source, name):
    relative = f"inputs/{name}.png"
    with Image.open(source) as image:
        image.convert("RGBA").save(root / relative)
    return {"file": relative}


def save_plan(root, plan):
    plan["version"] = 1
    plan["files"] = {str(p.relative_to(root)): digest(p.read_bytes()) for p in sorted((root / "inputs").iterdir())}
    plan["hash"] = digest(canonical(plan))
    write_json(root / "plan.json", plan)
    return plan


def image_plan(root, prompt, size, target, preset="sprite", model=DEFAULT_MODEL,
               quality="low", background="transparent", references=(), mask=None, settings=None):
    check_canvas(size)
    if not prompt.strip() or len(prompt) > 32000:
        raise ValueError("Prompt must contain 1–32000 characters")
    if len(references) > 16:
        raise ValueError("An edit supports at most 16 references")
    if mask and not references:
        raise ValueError("A mask requires a reference image")
    if preset == "item" and target[0] != target[1]:
        raise ValueError("The item preset requires a square target; use sprite for rectangular art")
    if mask:
        with Image.open(mask) as mask_image, Image.open(references[0]) as first:
            if mask_image.size != first.size or "A" not in mask_image.getbands():
                raise ValueError("Mask must have alpha and match the first reference dimensions")
    new_directory(root)
    inputs = [copy_image(root, path, f"reference-{i}") for i, path in enumerate(references)]
    mask_input = copy_image(root, mask, "mask") if mask else None
    (root / "inputs/prompt.txt").write_text(prompt)
    call = {"id": "image", "prompt": prompt, "model": model, "quality": quality,
            "size": list(size), "background": background, "inputs": inputs, "mask": mask_input}
    return save_plan(root, {"kind": "image", "target": list(target),
                            "filter": PRESETS[preset] if settings is None else settings, "calls": [call]})


def tiles_plan(root, material, model=DEFAULT_MODEL):
    if not isinstance(material, dict) or not all(isinstance(value, str) for value in material.values()):
        raise ValueError("Material must be a JSON object of text descriptions")
    material = dict(material)
    underside = material.pop("bottom", "")
    problems = prompts.check(material)
    if material.get("kind") != "outdoor":
        problems.append("voxel materials require kind: outdoor")
    if not isinstance(underside, str) or not underside.strip():
        problems.append("bottom must describe the underside")
    if problems:
        raise ValueError("; ".join(problems))
    new_directory(root)
    for height in (1, 3):
        Image.fromarray(draft.draft(height)[1]).save(root / f"inputs/guide-h{height}.png")
    bottom_material = {**material, "floor": underside,
                       "rim": underside + ". A narrow rounded edge of this same underside material"}
    bottom_prompt = prompts.build(bottom_material, 3, False).replace(
        "for a top-down 2D RPG, seen from the classic three-quarter top-down game camera",
        "for a 3D voxel material, with each texture surface viewed straight-on")
    bottom_prompt += ("\nThe horizontal regions are swatches for downward-facing voxel surfaces. "
                      "Image 2 is the top-and-side sheet: match its stone/earth palette and pixel scale. "
                      "No grass, perspective, baked lighting or scenery on the underside swatches.")
    calls = []
    for sid, height, prompt, inputs in [
        ("h3", 3, prompts.build(material, 3, False), [{"file": "inputs/guide-h3.png"}]),
        ("h1", 1, prompts.build(material, 1, True), [{"file": "inputs/guide-h1.png"},
             {"call": "h3", "crop": list(layout.ground_box(3))}]),
        ("bottom", 3, bottom_prompt, [{"file": "inputs/guide-h3.png"}, {"call": "h3"}]),
    ]:
        (root / f"inputs/prompt-{sid}.txt").write_text(prompt)
        calls.append({"id": sid, "height": height, "model": model, "quality": "medium", "prompt": prompt,
                      "size": list(layout.SHEET), "background": "opaque", "inputs": inputs, "mask": None})
    return save_plan(root, {"kind": "voxel_tiles", "material": {**material, "bottom": underside}, "calls": calls})
