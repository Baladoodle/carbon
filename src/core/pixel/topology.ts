/**
 * Port of Genforge `genforge/filters/topology.py`: the parts the presets use —
 * component labelling, negative space, topology-preserving pooling
 * (`_pool_source`), the silhouette grammar (`_grammar_mask`), the contour, the
 * material rim (`_apply_material_rim`) and the adaptive palette
 * (`allocate_adaptive_palette`).
 *
 * NumPy float32 semantics are reproduced where they decide a pixel:
 * - float32 arrays compared with a Python float compare in float32 (NEP 50), so
 *   thresholds are `F(0.22)`; values passed through `float(...)` compare in
 *   float64 against the plain literal.
 * - `region.sum()` over a strided float32 block is NumPy's pairwise sum over
 *   buffered chunks of whole rows (8192 elements); a contiguous block is one
 *   pairwise run. `(h,w,3).sum(axis=(0,1))` accumulates sequentially.
 * These were established empirically against NumPy 2.5 (docs/build-notes/pixel.md).
 */
import { fround, pairwiseSum, roundHalfEven } from './py';

type RGB = readonly [number, number, number];
const F = fround;

export const HARD_NAVY_OUTLINE: RGB = [24, 32, 48];

export interface Grid<T> {
  w: number;
  h: number;
  data: T;
}

const N4: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const N8: Array<[number, number]> = [...N4, [-1, -1], [-1, 1], [1, -1], [1, 1]];

const DX = Int32Array.from(N8, ([dx]) => dx);
const DY = Int32Array.from(N8, ([, dy]) => dy);

/** `_neighbors`. */
function* neighbors(
  x: number,
  y: number,
  w: number,
  h: number,
  diagonal = true,
): Generator<[number, number]> {
  for (const [dx, dy] of diagonal ? N8 : N4) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < w && ny >= 0 && ny < h) yield [nx, ny];
  }
}

export interface ComponentInfo {
  id: number;
  area: number;
  bounds: [number, number, number, number];
}

/** `_label_components`: row-major ids from 1. */
export function labelComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  diagonal = true,
): { labels: Int32Array; components: ComponentInfo[] } {
  const labels = new Int32Array(w * h);
  const components: ComponentInfo[] = [];
  let next = 0;
  const queue = new Int32Array(w * h);
  const offs = diagonal ? 8 : 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = y * w + x;
      if (!mask[s] || labels[s]) continue;
      next++;
      let qh = 0;
      let qt = 0;
      queue[qt++] = s;
      labels[s] = next;
      let x0 = x;
      let x1 = x;
      let y0 = y;
      let y1 = y;
      let area = 0;
      while (qh < qt) {
        const k = queue[qh++] ?? 0;
        const cx = k % w;
        const cy = (k - cx) / w;
        area++;
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
        for (let o = 0; o < offs; o++) {
          const nx = cx + (DX[o] as number);
          const ny = cy + (DY[o] as number);
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const n = ny * w + nx;
          if (mask[n] && !labels[n]) {
            labels[n] = next;
            queue[qt++] = n;
          }
        }
      }
      components.push({ id: next, area, bounds: [x0, y0, x1 + 1, y1 + 1] });
    }
  }
  return { labels, components };
}

/** `_negative_space`: hole and channel masks of the background. */
export function negativeSpace(
  mask: Uint8Array,
  w: number,
  h: number,
): { holes: Uint8Array; channels: Uint8Array } {
  const inv = new Uint8Array(w * h);
  let solid = 0;
  for (let i = 0; i < w * h; i++) {
    inv[i] = mask[i] ? 0 : 1;
    solid += mask[i] ? 1 : 0;
  }
  const { labels, components } = labelComponents(inv, w, h, false);
  const exterior = new Set<number>();
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const l = labels[y * w + x] ?? 0;
      if (l) exterior.add(l);
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const l = labels[y * w + x] ?? 0;
      if (l) exterior.add(l);
    }
  }
  const scale = Math.max(h, w);
  const channelIds = new Set<number>();
  for (const r of components) {
    if (!exterior.has(r.id)) continue;
    const [x0, y0, x1, y1] = r.bounds;
    const narrow =
      Math.min(x1 - x0, y1 - y0) <= Math.max(4, Math.trunc(roundHalfEven(scale * 0.14)));
    const long = Math.max(x1 - x0, y1 - y0) >= Math.max(5, Math.trunc(roundHalfEven(scale * 0.22)));
    if (r.area >= Math.max(8, Math.trunc(solid * 0.00015)) && narrow && long) channelIds.add(r.id);
  }
  const holes = new Uint8Array(w * h);
  const channels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const l = labels[i] ?? 0;
    if (!l) continue;
    if (!exterior.has(l)) holes[i] = 1;
    if (channelIds.has(l)) channels[i] = 1;
  }
  return { holes, channels };
}

export interface Pooled {
  coverage: Float32Array;
  material: Float32Array; // w*h*3
  holes: Float32Array;
  channels: Float32Array;
  edge: Float32Array;
  dominant: Int32Array;
  fraction: Float32Array;
  edgeSupport: Float32Array;
  sideSupport: Float32Array; // w*h*4
  presence: Uint8Array;
  fitted: [number, number];
}

const BUFFER = 8192;

/** `float32_block.sum()` for rows [y0,y1) × cols [x0,x1) of a row-major array of width `stride`. */
function blockSumF32(
  values: Float32Array,
  stride: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number {
  const bw = x1 - x0;
  const bh = y1 - y0;
  const contiguous = bw === stride || bh === 1;
  const flat = new Float32Array(bw * bh);
  for (let y = y0; y < y1; y++)
    flat.set(values.subarray(y * stride + x0, y * stride + x1), (y - y0) * bw);
  if (contiguous) return pairwiseSum(flat, 0, flat.length, F);
  const rowsPer = Math.max(1, Math.floor(BUFFER / bw));
  let acc = 0;
  for (let r = 0; r < bh; r += rowsPer) {
    const n = Math.min(rowsPer, bh - r) * bw;
    acc = F(acc + pairwiseSum(flat, r * bw, n, F));
  }
  return acc;
}

/** `_pool_source` (margin 0, not a tile, anchor bottom, no symmetry, fit_bounds = the whole image). */
export function poolSource(
  rgba: Uint8Array,
  W: number,
  H: number,
  solid: Uint8Array,
  labels: Int32Array,
  holeMask: Uint8Array,
  channelMask: Uint8Array,
  target: [number, number],
  coverageFromMask: boolean,
): Pooled {
  const [tw, th] = target;
  const width = W;
  const height = H;
  const spanW = Math.max(1, tw);
  const spanH = Math.max(1, th);
  const scale = Math.min(spanW / Math.max(1, width), spanH / Math.max(1, height));
  let fw = Math.max(1, Math.min(spanW, Math.trunc(roundHalfEven(width * scale))));
  let fh = Math.max(1, Math.min(spanH, Math.trunc(roundHalfEven(height * scale))));
  const aspect = width / Math.max(1, height);
  let both = 0;
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = solid[y * width + x] ?? 0;
      total += a;
      both += a & (solid[y * width + (width - 1 - x)] ?? 0);
    }
  }
  const symH = (2.0 * both) / Math.max(1, total * 2);
  if (aspect >= 0.9 && aspect <= 1.11 && spanW === spanH) {
    let dim = Math.min(fw, fh);
    if (tw % 2 === 0 && dim % 2 === 1 && dim + 1 <= spanW) dim += 1;
    fw = dim;
    fh = dim;
  }
  if (tw % 2 === 0 && fw % 2 === 1 && fw + 1 <= spanW && symH >= 0.88) fw += 1;
  const ox = Math.floor((tw - fw) / 2);
  const oy = th - fh; // anchor "bottom", margin 0

  const n = tw * th;
  const P: Pooled = {
    coverage: new Float32Array(n),
    material: new Float32Array(n * 3),
    holes: new Float32Array(n),
    channels: new Float32Array(n),
    edge: new Float32Array(n),
    dominant: new Int32Array(n).fill(-1),
    fraction: new Float32Array(n),
    edgeSupport: new Float32Array(n),
    sideSupport: new Float32Array(n * 4),
    presence: new Uint8Array(n),
    fitted: [fw, fh],
  };
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = F((rgba[i * 4 + 3] ?? 0) / 255);
  const isEdgePx = (px: number, py: number): boolean =>
    px === 0 || py === 0 || px === width - 1 || py === height - 1;

  for (let ty = 0; ty < fh; ty++) {
    const sy0 = Math.min(height - 1, Math.floor((ty * height) / fh));
    const sy1 = Math.min(height, Math.max(sy0 + 1, Math.ceil(((ty + 1) * height) / fh)));
    for (let tx = 0; tx < fw; tx++) {
      const sx0 = Math.min(width - 1, Math.floor((tx * width) / fw));
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.ceil(((tx + 1) * width) / fw)));
      const cells = (sy1 - sy0) * (sx1 - sx0);
      const t = (oy + ty) * tw + (ox + tx);

      let fg = 0;
      let holeN = 0;
      let chanN = 0;
      let mr = 0;
      let mg = 0;
      let mb = 0;
      const ids = new Map<number, number>();
      let edgePixels = 0;
      let edgeCount = 0;
      for (let py = sy0; py < sy1; py++) {
        for (let px = sx0; px < sx1; px++) {
          const i = py * width + px;
          const a = alpha[i] ?? 0;
          mr = F(mr + F((rgba[i * 4] ?? 0) * a));
          mg = F(mg + F((rgba[i * 4 + 1] ?? 0) * a));
          mb = F(mb + F((rgba[i * 4 + 2] ?? 0) * a));
          holeN += holeMask[i] ?? 0;
          chanN += channelMask[i] ?? 0;
          if (!solid[i]) continue;
          fg++;
          const l = labels[i] ?? 0;
          ids.set(l, (ids.get(l) ?? 0) + 1);
          if (isEdgePx(px, py)) edgePixels++;
          if (
            isEdgePx(px, py) ||
            !solid[py * width + Math.max(0, px - 1)] ||
            !solid[py * width + Math.min(width - 1, px + 1)] ||
            !solid[Math.max(0, py - 1) * width + px] ||
            !solid[Math.min(height - 1, py + 1) * width + px]
          ) {
            edgeCount++;
          }
        }
      }
      const alphaSum = blockSumF32(alpha, W, sx0, sx1, sy0, sy1);
      // float32 mean = float32 sum / count (float64 division then rounding is exact here)
      P.coverage[t] = coverageFromMask ? F(fg / cells) : F(alphaSum / cells);
      P.holes[t] = F(holeN / cells);
      P.channels[t] = F(chanN / cells);
      P.presence[t] = fg > 0 ? 1 : 0;
      if (alphaSum > 1e-6) {
        P.material[t * 3] = F(mr / alphaSum);
        P.material[t * 3 + 1] = F(mg / alphaSum);
        P.material[t * 3 + 2] = F(mb / alphaSum);
      } else {
        const i = sy0 * width + sx0;
        P.material[t * 3] = rgba[i * 4] ?? 0;
        P.material[t * 3 + 1] = rgba[i * 4 + 1] ?? 0;
        P.material[t * 3 + 2] = rgba[i * 4 + 2] ?? 0;
      }
      // valid ids sorted by (-count, id)
      let bestId = -1;
      let bestN = 0;
      for (const [id, cnt] of ids) {
        if (id <= 0) continue;
        if (cnt > bestN || (cnt === bestN && id < bestId)) {
          bestId = id;
          bestN = cnt;
        }
      }
      if (bestId > 0) {
        P.dominant[t] = bestId;
        P.fraction[t] = F(bestN / Math.max(1, fg));
      }
      const fgc = Math.max(1, fg);
      const rowSum = (py: number): number => {
        let s = 0;
        for (let px = sx0; px < sx1; px++) s += solid[py * width + px] ?? 0;
        return s;
      };
      const colSum = (px: number): number => {
        let s = 0;
        for (let py = sy0; py < sy1; py++) s += solid[py * width + px] ?? 0;
        return s;
      };
      if (sy0 === 0) P.sideSupport[t * 4] = F(rowSum(sy0) / fgc);
      if (sx1 === width) P.sideSupport[t * 4 + 1] = F(colSum(sx1 - 1) / fgc);
      if (sy1 === height) P.sideSupport[t * 4 + 2] = F(rowSum(sy1 - 1) / fgc);
      if (sx0 === 0) P.sideSupport[t * 4 + 3] = F(colSum(sx0) / fgc);
      P.edgeSupport[t] = F(edgePixels / Math.max(1, fg));
      P.edge[t] = F(edgeCount / Math.max(1, fg));
    }
  }
  return P;
}

/** `_contour`: mask pixels on the canvas edge or with a 4-neighbour outside. */
export function contour(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
        out[y * w + x] = 1;
        continue;
      }
      const i = y * w + x;
      if (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) out[i] = 1;
    }
  }
  return out;
}

function hasComponentPath(
  x: number,
  y: number,
  id: number,
  P: Pooled,
  mask: Uint8Array,
  w: number,
  h: number,
): boolean {
  const allowed = (i: number): boolean =>
    !!P.presence[i] && P.dominant[i] === id && (P.fraction[i] ?? 0) >= F(0.35);
  if (!allowed(y * w + x)) return false;
  const queue: Array<[number, number]> = [[x, y]];
  const seen = new Set<number>([y * w + x]);
  for (let qi = 0; qi < queue.length; qi++) {
    const [cx, cy] = queue[qi] ?? [0, 0];
    if ((cx !== x || cy !== y) && mask[cy * w + cx]) return true;
    for (const [nx, ny] of neighbors(cx, cy, w, h, false)) {
      const n = ny * w + nx;
      if (allowed(n) && !seen.has(n)) {
        seen.add(n);
        queue.push([nx, ny]);
      }
    }
  }
  return false;
}

function promoteEdges(mask: Uint8Array, P: Pooled, target: [number, number]): void {
  const [tw, th] = target;
  const [width, height] = P.fitted;
  const x0 = Math.floor((tw - width) / 2);
  const y0 = Math.floor((th - height) / 2);
  const cells = new Set<number>();
  for (let x = x0; x < x0 + width; x++)
    for (const y of [y0, y0 + height - 1]) cells.add(x * 100000 + y);
  for (let y = y0; y < y0 + height; y++)
    for (const x of [x0, x0 + width - 1]) cells.add(x * 100000 + y);
  // sorted((x, y)): by x, then y
  for (const c of [...cells].sort((a, b) => a - b)) {
    const x = Math.floor(c / 100000);
    const y = c % 100000;
    const t = y * tw + x;
    if (mask[t]) continue;
    const sides: number[] = [];
    if (y === y0) sides.push(0);
    if (x === x0 + width - 1) sides.push(1);
    if (y === y0 + height - 1) sides.push(2);
    if (x === x0) sides.push(3);
    const corresponding = sides.reduce((m, s) => Math.max(m, P.sideSupport[t * 4 + s] ?? 0), 0.0);
    const cov = P.coverage[t] ?? 0;
    const es = P.edge[t] ?? 0;
    if (cov < F(0.08) || (P.edgeSupport[t] ?? 0) < F(0.15) || corresponding < 0.04 || es < F(0.2))
      continue;
    const id = P.dominant[t] ?? -1;
    if (
      id < 1 ||
      (P.fraction[t] ?? 0) < F(0.55) ||
      (P.holes[t] ?? 0) >= F(0.22) ||
      (P.channels[t] ?? 0) >= F(0.22)
    )
      continue;
    const path = hasComponentPath(x, y, id, P, mask, tw, th);
    const endpoint = cov >= F(0.3) && es >= F(0.7);
    if (!path && !endpoint) continue;
    mask[t] = 1;
  }
}

function validIds(components: ComponentInfo[], P: Pooled): number[] {
  if (components.length)
    return components
      .filter((c) => c.area >= 16)
      .map((c) => c.id)
      .sort((a, b) => a - b);
  return [...new Set([...P.dominant].filter((v) => v > 0))].sort((a, b) => a - b);
}

function preserveComponentPaths(
  mask: Uint8Array,
  P: Pooled,
  components: ComponentInfo[],
  w: number,
  h: number,
): void {
  const ids = new Set(validIds(components, P));
  if (!ids.size) return;
  const evidence = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    const d = P.dominant[i] ?? -1;
    if (
      P.presence[i] &&
      (P.coverage[i] ?? 0) >= F(0.035) &&
      d > 0 &&
      ids.has(d) &&
      (P.fraction[i] ?? 0) >= F(0.2) &&
      (P.holes[i] ?? 0) < F(0.28) &&
      (P.channels[i] ?? 0) < F(0.38)
    ) {
      evidence[i] = 1;
      any = true;
    }
  }
  if (!any) return;
  const { labels, components: comps } = labelComponents(evidence, w, h, true);
  for (const comp of comps) {
    const coords: number[] = [];
    for (let i = 0; i < w * h; i++) if (labels[i] === comp.id) coords.push(i);
    if (coords.length < 2) continue;
    let touches = false;
    for (const i of coords) {
      const x = i % w;
      const y = (i - x) / w;
      if (mask[i]) {
        touches = true;
        break;
      }
      for (const [nx, ny] of neighbors(x, y, w, h, true)) {
        if (mask[ny * w + nx]) {
          touches = true;
          break;
        }
      }
      if (touches) break;
    }
    if (!touches) continue;
    for (const i of coords) if ((P.coverage[i] ?? 0) < 0.16) mask[i] = 1; // float(coverage) < 0.16: float64 compare
  }
}

/** `_grammar_mask` (margin 0, not a tile). */
export function grammarMask(
  P: Pooled,
  target: [number, number],
  components: ComponentInfo[],
  softness: number,
): Uint8Array {
  const [tw, th] = target;
  const n = tw * th;
  const cov = P.coverage;
  const mask = new Uint8Array(n);
  const reserved = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = cov[i] ?? 0;
    mask[i] = c >= F(0.22) ? 1 : 0;
    const rh = (P.holes[i] ?? 0) >= F(0.28) && c < F(0.52);
    const rc = (P.channels[i] ?? 0) >= F(0.38) && c < F(0.2);
    if (rh || rc) {
      reserved[i] = 1;
      mask[i] = 0;
    }
  }
  promoteEdges(mask, P, target);

  for (const id of validIds(components, P)) {
    let represented = false;
    for (let i = 0; i < n; i++) {
      if (mask[i] && P.dominant[i] === id && (P.fraction[i] ?? 0) >= F(0.45)) {
        represented = true;
        break;
      }
    }
    if (represented) continue;
    let best: [number, number, number] | null = null;
    for (let i = 0; i < n; i++) {
      if (!(
        P.presence[i] &&
        P.dominant[i] === id &&
        (P.fraction[i] ?? 0) >= F(0.45) &&
        !reserved[i]
      ))
        continue;
      if ((P.holes[i] ?? 0) >= F(0.22) || (P.channels[i] ?? 0) >= F(0.22)) continue;
      const score = F((cov[i] ?? 0) + F(F(0.2) * (P.edge[i] ?? 0)));
      const y = Math.floor(i / tw);
      const x = i % tw;
      // max by (score, -y, -x)
      if (
        !best ||
        score > best[0] ||
        (score === best[0] && (y < best[1] || (y === best[1] && x < best[2])))
      )
        best = [score, y, x];
    }
    if (best) mask[best[1] * tw + best[2]] = 1;
  }

  const ys = 1;
  const ye = Math.min(th - 1, th);
  const xs = 1;
  const xe = Math.min(tw - 1, tw);
  const at = (x: number, y: number): number => mask[y * tw + x] ?? 0;

  for (let pass = 0; pass < 2; pass++) {
    for (let y = ys; y < ye; y++) {
      for (let x = xs; x < xe; x++) {
        const i = y * tw + x;
        if (mask[i] || reserved[i] || (cov[i] ?? 0) < F(0.12)) continue;
        const id = P.dominant[i] ?? -1;
        if (
          id < 1 ||
          (P.fraction[i] ?? 0) < F(0.45) ||
          (P.holes[i] ?? 0) >= F(0.18) ||
          (P.channels[i] ?? 0) >= F(0.18)
        )
          continue;
        let sameFour = 0;
        let sameDiag = 0;
        for (const [nx, ny] of neighbors(x, y, tw, th, false))
          if (at(nx, ny) && P.dominant[ny * tw + nx] === id) sameFour++;
        for (const [nx, ny] of neighbors(x, y, tw, th, true)) {
          if (
            Math.abs(nx - x) === 1 &&
            Math.abs(ny - y) === 1 &&
            at(nx, ny) &&
            P.dominant[ny * tw + nx] === id
          )
            sameDiag++;
        }
        const horizontal =
          x > 0 &&
          at(x - 1, y) &&
          P.dominant[i - 1] === id &&
          x + 1 < tw &&
          at(x + 1, y) &&
          P.dominant[i + 1] === id;
        const vertical =
          y > 0 &&
          at(x, y - 1) &&
          P.dominant[i - tw] === id &&
          y + 1 < th &&
          at(x, y + 1) &&
          P.dominant[i + tw] === id;
        if ((horizontal || vertical) && sameFour >= 2 && sameFour + sameDiag >= 3) mask[i] = 1;
      }
    }
  }

  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const i = y * tw + x;
      const c = cov[i] ?? 0;
      const hl = P.holes[i] ?? 0;
      if (
        mask[i] ||
        reserved[i] ||
        hl >= F(0.15) ||
        (P.channels[i] ?? 0) >= F(0.2) ||
        c < F(0.08) ||
        !P.presence[i]
      )
        continue;
      const ns = at(x, y - 1) && at(x, y + 1);
      const ew = at(x - 1, y) && at(x + 1, y);
      const d1 = at(x - 1, y - 1) && at(x + 1, y + 1);
      const d2 = at(x + 1, y - 1) && at(x - 1, y + 1);
      const turn =
        ((at(x, y - 1) && at(x + 1, y)) ||
          (at(x, y - 1) && at(x - 1, y)) ||
          (at(x, y + 1) && at(x + 1, y)) ||
          (at(x, y + 1) && at(x - 1, y))) &&
        c >= F(0.16) &&
        hl < F(0.08);
      if ((ns || ew || d1 || d2) && c >= F(0.08)) mask[i] = 1;
      else if (turn) mask[i] = 1;
    }
  }

  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const i = y * tw + x;
      if (mask[i] || reserved[i] || (cov[i] ?? 0) < F(0.34)) continue;
      let four = 0;
      for (const [nx, ny] of neighbors(x, y, tw, th, false)) four += at(nx, ny);
      if (four >= 3) mask[i] = 1;
    }
  }

  if (softness >= 0.65) {
    for (let y = 0; y < th - 1; y++) {
      for (let x = 0; x < tw - 1; x++) {
        const coords: Array<[number, number]> = [
          [y, x],
          [y, x + 1],
          [y + 1, x],
          [y + 1, x + 1],
        ];
        if (coords.reduce((s, [cy, cx]) => s + at(cx, cy), 0) !== 3) continue;
        const empty = coords.findIndex(([cy, cx]) => !at(cx, cy));
        const corner = 3 - empty;
        const [cy, cx] = coords[corner] ?? [0, 0];
        let exterior = 0;
        for (const [nx, ny] of neighbors(cx, cy, tw, th, true)) exterior += at(nx, ny) ? 0 : 1;
        if (exterior >= 3 && (cov[cy * tw + cx] ?? 0) < F(0.4)) {
          const others = [0, 1, 2, 3].filter((k) => k !== empty && k !== corner);
          const conns = (k: number): number => {
            const [oy, ox] = coords[k] ?? [0, 0];
            let s = 0;
            for (const [nx, ny] of neighbors(ox, oy, tw, th, true)) {
              if (!coords.some(([py, px]) => py === ny && px === nx)) s += at(nx, ny);
            }
            return s;
          };
          if (conns(others[0] ?? 0) >= 1 && conns(others[1] ?? 0) >= 1) mask[cy * tw + cx] = 0;
        }
      }
    }
  }

  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const i = y * tw + x;
      if (!mask[i]) continue;
      let four = 0;
      let diag = 0;
      for (const [nx, ny] of neighbors(x, y, tw, th, false)) four += at(nx, ny);
      for (const [nx, ny] of neighbors(x, y, tw, th, true)) {
        if (Math.abs(nx - x) === 1 && Math.abs(ny - y) === 1) diag += at(nx, ny);
      }
      if (four === 0 && diag === 0) mask[i] = 0;
      else if (four === 0 && diag === 1 && (cov[i] ?? 0) < F(0.12) && !P.presence[i]) mask[i] = 0;
    }
  }

  preserveComponentPaths(mask, P, components, tw, th);
  return mask;
}

/** `_apply_material_rim` with a palette, no saturation limit, emissives preserved. In place. */
export function applyMaterialRim(
  pixels: Uint8Array,
  mask: Uint8Array,
  cont: Uint8Array,
  w: number,
  h: number,
  outlineDarken: number,
  maxRimColors: number,
  palette: RGB[] | null,
): void {
  const coords: number[] = [];
  for (let i = 0; i < w * h; i++) if (cont[i] && mask[i]) coords.push(i);
  if (!coords.length) return;
  const rimColor = (anchor: readonly number[], factor: number): RGB => {
    let a = anchor.map((v) => F(v));
    if (palette?.length) {
      let best: RGB = palette[0] ?? [0, 0, 0];
      let bestD = Infinity;
      for (const c of palette) {
        // np.sum of a 3-vector of float32 squares: sequential from -0.0
        const d = F(
          F(F(-0 + F(F((a[0] ?? 0) - c[0]) ** 2)) + F(F((a[1] ?? 0) - c[1]) ** 2)) +
            F(F((a[2] ?? 0) - c[2]) ** 2),
        );
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      a = [...best];
    }
    let scaled = a.map((v) => Math.min(255, Math.max(0, F(v * F(factor)))));
    if (palette?.length) scaled = scaled.map((v) => F(roundHalfEven(F(v / 8)) * 8));
    return scaled.map((v) => Math.min(255, Math.max(0, roundHalfEven(v)))) as unknown as RGB;
  };
  const candidates: RGB[] = [];
  const active: number[] = [];
  for (const i of coords) {
    const r = pixels[i * 4] ?? 0;
    const g = pixels[i * 4 + 1] ?? 0;
    const b = pixels[i * 4 + 2] ?? 0;
    const white = r >= 210 && g >= 190 && b >= 150;
    const gold = r >= 230 && g >= 150 && b < 120 && r - g >= 48;
    const spec = r >= 245 && g >= 245 && b >= 245;
    if (white || gold || spec) continue;
    const x = i % w;
    const y = (i - x) / w;
    const samples: number[][] = [[], [], []];
    for (let ny = Math.max(0, y - 2); ny < Math.min(h, y + 3); ny++) {
      for (let nx = Math.max(0, x - 2); nx < Math.min(w, x + 3); nx++) {
        const n = ny * w + nx;
        if (mask[n] && !cont[n])
          for (let c = 0; c < 3; c++) samples[c]?.push(pixels[n * 4 + c] ?? 0);
      }
    }
    if (samples[0]?.length) {
      const med = samples.map((s) => {
        const v = [...s].sort((p, q) => p - q);
        const k = v.length;
        return k % 2 ? (v[(k - 1) / 2] ?? 0) : ((v[k / 2 - 1] ?? 0) + (v[k / 2] ?? 0)) / 2;
      });
      candidates.push(rimColor(med, outlineDarken));
      active.push(i);
    } else {
      pixels.set(rimColor([r, g, b], Math.max(0.8, outlineDarken)), i * 4);
    }
  }
  if (!candidates.length) return;
  const key = (c: RGB): number => (c[0] << 16) | (c[1] << 8) | c[2];
  const unique = [...new Map(candidates.map((c) => [key(c), c])).values()].sort(
    (p, q) => key(p) - key(q),
  );
  let rim: RGB[];
  if (unique.length <= maxRimColors) rim = unique;
  else {
    const lum = (c: RGB): number => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
    const ordered = unique
      .map((c, k) => ({ c, k }))
      .sort((p, q) => lum(p.c) - lum(q.c) || p.k - q.k)
      .map((e) => e.c);
    const step = ordered.length / maxRimColors;
    rim = Array.from(
      { length: maxRimColors },
      (_, k) => ordered[Math.trunc(k * step)] ?? [0, 0, 0],
    );
  }
  active.forEach((i, k) => {
    const c = candidates[k] ?? [0, 0, 0];
    let best = rim[0] ?? [0, 0, 0];
    let bestD = Infinity;
    for (const r of rim) {
      const d = (r[0] - c[0]) ** 2 + (r[1] - c[1]) ** 2 + (r[2] - c[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    pixels.set(best, i * 4);
  });
}

function hueFamily(rgb: RGB): string {
  const r = rgb[0] / 255.0;
  const g = rgb[1] / 255.0;
  const b = rgb[2] / 255.0;
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const chroma = high - low;
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  if (lum <= 50.0 && Math.max(...rgb) - Math.min(...rgb) <= 24) return 'contour';
  if (chroma <= 0.12) return 'neutral';
  let hue: number;
  const pmod = (v: number, m: number): number => {
    const q = v % m;
    return q !== 0 && q < 0 !== m < 0 ? q + m : q;
  };
  if (high === r) hue = 60.0 * pmod((g - b) / chroma, 6.0);
  else if (high === g) hue = 60.0 * ((b - r) / chroma + 2.0);
  else hue = 60.0 * ((r - g) / chroma + 4.0);
  hue = pmod(hue, 360.0);
  return `hue_${pmod(Math.floor((hue + 22.5) / 45.0), 8)}`;
}

/** `allocate_adaptive_palette` over the masked materials (float32, truncated to int). */
export function allocateAdaptivePalette(
  materials: Float32Array,
  mask: Uint8Array,
  minColors: number,
  maxColors: number,
  split: 'range' | 'variance',
  tonesPerMaterial = 3,
  varianceThreshold = 45.0,
): RGB[] {
  const pixels: RGB[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i])
      pixels.push([
        Math.trunc(materials[i * 3] ?? 0),
        Math.trunc(materials[i * 3 + 1] ?? 0),
        Math.trunc(materials[i * 3 + 2] ?? 0),
      ]);
  }
  if (!pixels.length) return [HARD_NAVY_OUTLINE];
  const families = new Map<string, number>();
  for (const p of pixels) families.set(hueFamily(p), (families.get(hueFamily(p)) ?? 0) + 1);
  const total = Math.max(1, pixels.length);
  let significant = [...families].filter(([, c]) => c / total >= 0.05).length;
  if (!significant) significant = families.size;
  const target = Math.max(minColors, Math.min(maxColors, significant * tonesPerMaterial + 1));

  const key = (c: RGB): number => (c[0] << 16) | (c[1] << 8) | c[2];
  const counts = new Map<number, [RGB, number]>();
  for (const p of pixels) {
    const e = counts.get(key(p));
    if (e) e[1]++;
    else counts.set(key(p), [p, 1]);
  }
  const boxes: Array<Array<[RGB, number]>> = [[...counts.values()].map(([c, n]) => [c, n])];
  while (boxes.length < target) {
    let bestIdx = -1;
    let maxVar = -1.0;
    boxes.forEach((box, idx) => {
      if (box.length < 2) return;
      if (split === 'variance') {
        let spread = 0;
        for (let ch = 0; ch < 3; ch++) {
          let lo = Infinity;
          let hi = -Infinity;
          for (const [c] of box) {
            lo = Math.min(lo, c[ch] ?? 0);
            hi = Math.max(hi, c[ch] ?? 0);
          }
          spread = Math.max(spread, hi - lo);
        }
        if (spread < varianceThreshold) return;
        const wts = Float64Array.from(box, ([, n]) => n);
        const wsum = pairwiseSum(wts, 0, wts.length);
        const mean = [0, 1, 2].map((ch) => {
          let s = 0;
          for (const [c, n] of box) s += (c[ch] ?? 0) * n;
          return s / wsum;
        });
        const terms = Float64Array.from(box, ([c, n]) => {
          let r = -0.0;
          for (let ch = 0; ch < 3; ch++) r += ((c[ch] ?? 0) - (mean[ch] ?? 0)) ** 2;
          return r * n;
        });
        const v = pairwiseSum(terms, 0, terms.length);
        if (v > maxVar) {
          maxVar = v;
          bestIdx = idx;
        }
        return;
      }
      for (let ch = 0; ch < 3; ch++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const [c] of box) {
          lo = Math.min(lo, c[ch] ?? 0);
          hi = Math.max(hi, c[ch] ?? 0);
        }
        if (hi - lo > maxVar) {
          maxVar = hi - lo;
          bestIdx = idx;
        }
      }
    });
    if (bestIdx < 0 || (split !== 'variance' && maxVar < varianceThreshold)) break;
    const box = boxes.splice(bestIdx, 1)[0] ?? [];
    let sc = 0;
    let span = -1;
    for (let ch = 0; ch < 3; ch++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const [c] of box) {
        lo = Math.min(lo, c[ch] ?? 0);
        hi = Math.max(hi, c[ch] ?? 0);
      }
      if (hi - lo > span) {
        span = hi - lo;
        sc = ch;
      }
    }
    box.sort((p, q) => (p[0][sc] ?? 0) - (q[0][sc] ?? 0)); // stable, key = channel only
    const halfway = box.reduce((s, [, n]) => s + n, 0) / 2.0;
    let running = 0;
    let sp = 1;
    for (let i = 1; i < box.length; i++) {
      running += box[i - 1]?.[1] ?? 0;
      if (running >= halfway) {
        sp = i;
        break;
      }
    }
    boxes.push(box.slice(0, sp), box.slice(sp));
  }
  const palette: RGB[] = [];
  for (const box of boxes) {
    const tw = box.reduce((s, [, n]) => s + n, 0);
    if (tw <= 0) continue;
    const mean = [0, 1, 2].map((ch) =>
      Math.trunc(roundHalfEven(box.reduce((s, [c, n]) => s + (c[ch] ?? 0) * n, 0) / tw)),
    );
    const snapped = mean.map((v) => Math.trunc(roundHalfEven(v / 8.0) * 8));
    palette.push([
      Math.min(255, Math.max(0, snapped[0] ?? 0)),
      Math.min(255, Math.max(0, snapped[1] ?? 0)),
      Math.min(255, Math.max(0, snapped[2] ?? 0)),
    ]);
  }
  const out = [...new Map(palette.map((c) => [key(c), c])).values()];
  return out.length ? out : [HARD_NAVY_OUTLINE];
}
