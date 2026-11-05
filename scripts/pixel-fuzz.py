"""Fuzz the TypeScript port against the real Genforge: random sprites (blobs, rings, lines, soft
alpha, blur) at random sizes, each preset at random targets (and `none` upscales).

    <venv>/bin/python -I scripts/pixel-fuzz.py <out-dir> <seed> <sources>
    PIXEL_FUZZ=<out-dir> npx vitest run src/core/pixel/fuzz.test.ts

Not committed output: the committed parity set is fixtures/pixel/reference/.
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from genforge import filters
from genforge.plans import PRESETS
out = sys.argv[1]; rng = np.random.default_rng(int(sys.argv[2]))
cases = []
for i in range(int(sys.argv[3])):
    W, H = int(rng.integers(24, 420)), int(rng.integers(24, 420))
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    for _ in range(int(rng.integers(1, 7))):
        c = tuple(int(v) for v in rng.integers(0, 256, 3)) + (int(rng.choice([255, 255, 200, 120])),)
        x0, y0 = int(rng.integers(0, W)), int(rng.integers(0, H)); x1, y1 = int(rng.integers(0, W)), int(rng.integers(0, H))
        k = int(rng.integers(0, 4))
        box = [min(x0, x1), min(y0, y1), max(x0, x1) + 1, max(y0, y1) + 1]
        if k == 0: d.ellipse(box, fill=c)
        elif k == 1: d.rectangle(box, fill=c)
        elif k == 2: d.line([x0, y0, x1, y1], fill=c, width=int(rng.integers(1, 6)))
        else: d.ellipse(box, outline=c, width=int(rng.integers(1, 8)))
    if rng.random() < 0.4:
        im = im.filter(ImageFilter.GaussianBlur(float(rng.uniform(0.5, 3))))
    im.save(f'{out}/s{i}.png')
    for preset in PRESETS:
        n = int(rng.integers(8, 40)); m = n if preset == 'item' else int(rng.integers(8, 40))
        if preset == 'none' and rng.random() < 0.3: n, m = W + int(rng.integers(1, 30)), H + int(rng.integers(1, 30))
        r = filters.render(Image.open(f'{out}/s{i}.png'), (n, m), PRESETS[preset]).convert('RGBA')
        r.save(f'{out}/s{i}-{preset}.png'); cases.append({'src': f's{i}', 'preset': preset, 'w': n, 'h': m})
json.dump(cases, open(f'{out}/cases.json', 'w'))
