"""Regenerate fixtures/pixel/pillow/: small random images and Pillow's own outputs for the
operations src/core/pixel/pil.ts emulates (LANCZOS, BOX, NEAREST resize; GaussianBlur).

    <venv>/bin/python -I scripts/pixel-pillow.py fixtures/pixel/pillow

Needs Pillow 12.3 (the version Genforge's references were made with). Deterministic (seeded).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, __version__

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(20261105)
cases = []
for i in range(12):
    w, h = int(rng.integers(1, 33)), int(rng.integers(1, 33))
    a = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
    a[..., 3] = np.where(rng.random((h, w)) < 0.3, 0, a[..., 3])
    Image.fromarray(a, "RGBA").save(out / f"src{i}.png")
    L = Image.fromarray(a[..., 0], "L")
    tw, th = int(rng.integers(1, 20)), int(rng.integers(1, 20))
    ops = {
        "lanczosL": L.resize((tw, th), Image.LANCZOS),
        "boxRGBA": Image.fromarray(a, "RGBA").resize((tw, th), Image.BOX),
        "nearestRGBA": Image.fromarray(a, "RGBA").resize((tw * 2, th * 3), Image.NEAREST),
        "blur04": L.filter(ImageFilter.GaussianBlur(0.4)),
        "blur25": L.filter(ImageFilter.GaussianBlur(2.5)),
    }
    for k, im in ops.items():
        im.save(out / f"{k}{i}.png")
    cases.append({"i": i, "tw": tw, "th": th})
(out / "cases.json").write_text(json.dumps({"pillow": __version__, "cases": cases}, indent=1) + "\n")
print(f"wrote {len(cases)} cases (Pillow {__version__})")
