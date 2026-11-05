/**
 * Deterministic median-cut palette quantization over opaque pixels, in place.
 * Pixels whose alpha is not 255 are left untouched. An image that already has
 * at most `n` opaque colours is unchanged (so quantization is idempotent).
 */
interface Entry {
  rgb: number;
  count: number;
}

const ch = (rgb: number, c: number): number => (rgb >> (16 - 8 * c)) & 255;

function range(box: Entry[]): { channel: number; span: number } {
  let best = { channel: 0, span: -1 };
  for (let c = 0; c < 3; c++) {
    let lo = 255;
    let hi = 0;
    for (const e of box) {
      const v = ch(e.rgb, c);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > best.span) best = { channel: c, span: hi - lo };
  }
  return best;
}

export function medianCut(colors: Map<number, number>, n: number): number[] {
  const all: Entry[] = [...colors]
    .map(([rgb, count]) => ({ rgb, count }))
    .sort((a, b) => a.rgb - b.rgb);
  if (all.length <= n) return all.map((e) => e.rgb);
  const boxes: Entry[][] = [all];
  while (boxes.length < n) {
    let pick = -1;
    let pickSpan = 0;
    let pickChannel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const r = range(box);
      if (r.span > pickSpan) {
        pick = i;
        pickSpan = r.span;
        pickChannel = r.channel;
      }
    });
    if (pick < 0) break;
    const box = (boxes[pick] ?? [])
      .slice()
      .sort((a, b) => ch(a.rgb, pickChannel) - ch(b.rgb, pickChannel) || a.rgb - b.rgb);
    const total = box.reduce((s, e) => s + e.count, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i]?.count ?? 0;
      cut = i + 1;
      if (acc * 2 >= total) break;
    }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let t = 0;
    for (const e of box) {
      r += ch(e.rgb, 0) * e.count;
      g += ch(e.rgb, 1) * e.count;
      b += ch(e.rgb, 2) * e.count;
      t += e.count;
    }
    const q = (v: number): number => Math.floor(v / t + 0.5);
    return (q(r) << 16) | (q(g) << 8) | q(b);
  });
}

export function quantize(d: Uint8ClampedArray, n: number): void {
  const colors = new Map<number, number>();
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] !== 255) continue;
    const rgb = ((d[p] ?? 0) << 16) | ((d[p + 1] ?? 0) << 8) | (d[p + 2] ?? 0);
    colors.set(rgb, (colors.get(rgb) ?? 0) + 1);
  }
  if (colors.size <= n) return;
  const palette = medianCut(colors, n);
  const map = new Map<number, number>();
  for (const rgb of colors.keys()) {
    let best = 0;
    let bestD = Infinity;
    palette.forEach((c, i) => {
      const dr = ch(c, 0) - ch(rgb, 0);
      const dg = ch(c, 1) - ch(rgb, 1);
      const db = ch(c, 2) - ch(rgb, 2);
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    map.set(rgb, palette[best] ?? 0);
  }
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] !== 255) continue;
    const rgb = map.get(((d[p] ?? 0) << 16) | ((d[p + 1] ?? 0) << 8) | (d[p + 2] ?? 0)) ?? 0;
    d[p] = ch(rgb, 0);
    d[p + 1] = ch(rgb, 1);
    d[p + 2] = ch(rgb, 2);
  }
}
