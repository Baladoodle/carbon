"""Rebuild outputs from retained sources; never calls the image provider."""
import io
import json
from pathlib import Path

from PIL import Image

from . import filters
from .files import digest, load_plan, write_json
from .imaging import pixel_hash
from .walls import evaluate, kit as K, layout as L


def source_path(root, sid):
    return root / "sources" / f"{sid}.png"


def import_sources(root, plan, sources):
    ids = {c["id"] for c in plan["calls"]}
    seen = set()
    for spec in sources:
        sid, separator, value = spec.partition("=")
        if not separator or sid not in ids or sid in seen:
            raise ValueError("Sources must be unique CALL_ID=PATH assignments from this plan")
        seen.add(sid)
        with Image.open(value) as image:
            stream = io.BytesIO()
            image.convert("RGBA").save(stream, "PNG")
        path = source_path(root, sid)
        data = stream.getvalue()
        if path.exists() and path.read_bytes() != data:
            raise ValueError(f"Retained source {sid} already exists; create a new plan to change it")
        if not path.exists():
            path.write_bytes(data)


def load_sources(root, plan):
    sources = {}
    for call in plan["calls"]:
        sid = call["id"]
        path = source_path(root, sid)
        with Image.open(path) as image:
            if image.size != tuple(call["size"]):
                raise ValueError(f"{sid}: source size {image.size} differs from requested {tuple(call['size'])}; source preserved")
            sources[sid] = image.convert("RGBA")
    return sources


def build_tiles(sources):
    main = K.assemble([(3, 1, evaluate.evaluate(sources["h3"], 3, "outdoor")),
                       (1, 1, evaluate.evaluate(sources["h1"], 1, "outdoor"))])
    bottom = K.assemble([(3, 1, evaluate.evaluate(sources["bottom"], 3, "outdoor"))])
    surfaces = {"top": {}, "side": {}, "bottom": {}}
    pixels, selected, flags = [], [], {}
    for surface, kit, heights in [("top", main, (3,)), ("side", main, (3, 1)), ("bottom", bottom, (3,))]:
        for height in heights:
            for (kind, key), candidates in sorted(kit.states[height].items(), key=lambda row: K.state_id(row[0])):
                if (surface == "side") != (kind == "face"):
                    continue
                state = ":".join(key) if kind == "face" else str(sum(int(flag) << i for i, flag in enumerate(key)))
                if not candidates:
                    raise ValueError(f"No source crop for {surface}:{state}")
                tile = candidates[0]
                index = len(pixels)
                pixels.append(tile.image)
                entry = {"tiles": [index], "faults": [tile.fault]}
                status = kit.flags[height].get((kind, key))
                if status:
                    entry["status"] = status
                    flags[f"{surface}:{state}"] = status
                surfaces[surface][state] = entry
                sheet = "bottom" if surface == "bottom" else "h3" if height == 3 else "h1"
                selected.append({"tile": index, "surface": surface, "state": state, "source": sheet,
                                 "cell": list(tile.cell), "fault": tile.fault,
                                 "borrowed_from": K.state_id(tile.borrowed_from) if tile.borrowed_from else None})
    expected = {"top": 47, "side": 36, "bottom": 47}
    if {s: len(table) for s, table in surfaces.items()} != expected:
        raise ValueError("Voxel export lacks its complete 47/36/47 state families")
    meta = {"geometry": "voxel-walls-v1", "image": "atlas.png", "tile_px": L.TILE,
            "columns": K.COLUMNS, "tilecount": len(pixels), "surfaces": surfaces,
            "edge_bits": list(K.EDGE_NAMES), "rules": "See tools/genforge/docs/tilesets.md and genforge.voxel.select"}
    atlas = K.atlas_of(pixels)
    baseline = {}
    for surface, table in surfaces.items():
        state = "mid:F:F" if surface == "side" else "0"
        baseline[surface] = Image.fromarray(pixels[table[state]["tiles"][0]])
    return atlas, meta, baseline, {"selected": selected, "faults": flags}


def build(root: Path, sources=()):
    plan = load_plan(root)
    import_sources(root, plan, sources)
    originals = load_sources(root, plan)
    receipt_path = root / "receipt.json"
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    for sid, record in receipt.get("calls", {}).items():
        if record.get("status") == "succeeded" and digest(source_path(root, sid).read_bytes()) != record["source_hash"]:
            raise ValueError(f"Retained generated source changed: {sid}")
    output = root / "output"
    output.mkdir(exist_ok=True)
    if plan["kind"] == "image":
        image = filters.render(originals["image"], tuple(plan["target"]), plan["filter"])
        image.save(output / "image.png")
        scale = min(4, max(1, 2048 // max(image.size)))
        image.resize((image.width * scale, image.height * scale), Image.Resampling.NEAREST).save(output / "preview.png")
    else:
        atlas, meta, baseline, review = build_tiles(originals)
        atlas.save(output / "atlas.png")
        meta["material"] = plan["material"]
        write_json(output / "tileset.json", meta)
        write_json(output / "review.json", review)
        atlas.resize((atlas.width * 4, atlas.height * 4), Image.Resampling.NEAREST).save(output / "preview.png")
        (output / "baseline").mkdir(exist_ok=True)
        for name, image in baseline.items():
            image.save(output / "baseline" / f"{name}.png")
    provenance = {"plan_hash": plan["hash"], "sources": {sid: {"pixels": pixel_hash(im),
                  "file_hash": digest(source_path(root, sid).read_bytes()),
                  "origin": "generated" if receipt.get("calls", {}).get(sid, {}).get("status") == "succeeded" else "imported"}
                  for sid, im in originals.items()},
                  "outputs": {str(p.relative_to(output)): digest(p.read_bytes()) for p in sorted(output.rglob("*"))
                              if p.is_file() and p.name != "provenance.json"}}
    write_json(output / "provenance.json", provenance)
    return provenance
