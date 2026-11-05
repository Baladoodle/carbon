/**
 * The OpenCV 4 operations Genforge's `hairlines` uses, on binary masks
 * (Uint8Array of 0/1, row-major): `getStructuringElement(MORPH_ELLIPSE)`,
 * `erode`/`dilate` with the default border (it never erodes or dilates), and
 * `connectedComponentsWithStats` (8-connectivity; only the stats and the
 * component membership are used, so label numbering is free).
 */
import { roundHalfEven } from './py';

export interface Mask {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Row spans [j1, j2) of an ellipse kernel of size (2r+1)². */
export function ellipseKernel(size: number): Array<[number, number]> {
  const r = Math.floor(size / 2);
  const c = Math.floor(size / 2);
  const inv = r ? 1 / (r * r) : 0;
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < size; i++) {
    const dy = i - r;
    let j1 = 0;
    let j2 = 0;
    if (Math.abs(dy) <= r) {
      const dx = roundHalfEven(c * Math.sqrt((r * r - dy * dy) * inv));
      j1 = Math.max(c - dx, 0);
      j2 = Math.min(c + dx + 1, size);
    }
    rows.push([j1, j2]);
  }
  return rows;
}

/**
 * Row-packed bitset: pixel x of row y is bit (x + pad·32) of the row's words;
 * `pad` words of ones on each side stand for OpenCV's neutral border. The margin
 * must cover the widest kernel row, so every position a shift reads is either a
 * pixel or genuine padding (run-ANDs at x < 0 would otherwise see in-row pixels).
 */
interface Bits {
  w: number;
  h: number;
  nw: number;
  pad: number;
  words: Uint32Array;
}

function pack(m: Mask, invert: boolean, margin: number): Bits {
  const pad = Math.ceil(margin / 32) + 1;
  const nw = pad * 2 + ((m.w + 31) >>> 5);
  const words = new Uint32Array(m.h * nw).fill(0xffffffff);
  const base = pad * 32;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if ((m.data[y * m.w + x] === 1) === invert) {
        const bit = x + base;
        const i = y * nw + (bit >>> 5);
        words[i] = ((words[i] as number) & ~(1 << (bit & 31))) >>> 0;
      }
    }
  }
  return { w: m.w, h: m.h, nw, pad, words };
}

const ONES = 0xffffffff;

/** out(x) = src(x + s) for one row; positions outside the row read as 1 (the neutral border). */
function shiftRow(src: Uint32Array, o: number, nw: number, s: number, out: Uint32Array): void {
  const ws = Math.floor(s / 32);
  const bs = s - ws * 32;
  for (let i = 0; i < nw; i++) {
    const j = i + ws;
    const lo = j >= 0 && j < nw ? (src[o + j] as number) : ONES;
    if (bs === 0) {
      out[i] = lo;
    } else {
      const hi = j + 1 >= 0 && j + 1 < nw ? (src[o + j + 1] as number) : ONES;
      out[i] = ((lo >>> bs) | (hi << (32 - bs))) >>> 0;
    }
  }
}

/**
 * Erode or dilate by a kernel symmetric about its centre, given as row spans
 * (half-width dx_i for kernel row i): output row y is the AND over kernel rows
 * of image row y+i-r eroded horizontally by dx_i. Dilation is the complement of
 * eroding the complement. Rows outside the image are skipped and columns
 * outside read as 1 in the eroded set: OpenCV's default border, neutral for both.
 */
function morph(m: Mask, kernel: Array<[number, number]>, op: 'erode' | 'dilate'): Mask {
  const invert = op === 'dilate';
  const r = Math.floor(kernel.length / 2);
  const rows: Array<[number, number]> = [];
  kernel.forEach(([j1, j2], i) => {
    if (j2 > j1) rows.push([i - r, r - j1]);
  });
  if (!rows.length) return { w: m.w, h: m.h, data: new Uint8Array(m.w * m.h).fill(invert ? 0 : 1) };
  const B = pack(m, invert, 2 * Math.max(...rows.map(([, d]) => d)) + 1);
  const { w, h, nw, pad, words } = B;
  const levels = [...new Set(rows.map(([, d]) => d))];
  const maxL = 2 * Math.max(...levels) + 1;
  const pows: number[] = [];
  for (let p = 1; p <= maxL; p *= 2) pows.push(p);
  // per row: S_p = AND of src[x .. x+p-1] for each power of two p (shared by all levels)
  const S = pows.map(() => new Uint32Array(nw));
  const t1 = new Uint32Array(nw);
  const t2 = new Uint32Array(nw);
  const eroded = new Map<number, Uint32Array>(levels.map((d) => [d, new Uint32Array(h * nw)]));
  for (let y = 0; y < h; y++) {
    const o = y * nw;
    (S[0] as Uint32Array).set(words.subarray(o, o + nw));
    for (let k = 1; k < pows.length; k++) {
      const prev = S[k - 1] as Uint32Array;
      const cur = S[k] as Uint32Array;
      shiftRow(prev, 0, nw, pows[k - 1] as number, t1);
      for (let i = 0; i < nw; i++) cur[i] = ((prev[i] as number) & (t1[i] as number)) >>> 0;
    }
    for (const d of levels) {
      const L = 2 * d + 1;
      let k = 0;
      while (k + 1 < pows.length && (pows[k + 1] as number) <= L) k++;
      const p = pows[k] as number;
      const Sp = S[k] as Uint32Array;
      // [x-d, x+d] = [x-d, x-d+p-1] ∪ [x+d-p+1, x+d]
      shiftRow(Sp, 0, nw, -d, t1);
      shiftRow(Sp, 0, nw, d - p + 1, t2);
      const e = eroded.get(d) as Uint32Array;
      for (let i = 0; i < nw; i++) e[o + i] = ((t1[i] as number) & (t2[i] as number)) >>> 0;
    }
  }
  const out = new Uint8Array(w * h);
  const acc = new Uint32Array(nw);
  for (let y = 0; y < h; y++) {
    acc.fill(0xffffffff);
    for (const [dy, d] of rows) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      const e = eroded.get(d) as Uint32Array;
      const o = yy * nw;
      for (let i = 0; i < nw; i++) acc[i] = ((acc[i] as number) & (e[o + i] as number)) >>> 0;
    }
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const p = x + pad * 32;
      const bit = ((acc[p >>> 5] as number) >>> (p & 31)) & 1;
      out[o + x] = invert ? 1 - bit : bit;
    }
  }
  return { w, h, data: out };
}

export const erode = (m: Mask, k: Array<[number, number]>): Mask => morph(m, k, 'erode');
export const dilate = (m: Mask, k: Array<[number, number]>): Mask => morph(m, k, 'dilate');
export const open = (m: Mask, k: Array<[number, number]>): Mask => dilate(erode(m, k), k);
export const SQUARE3: Array<[number, number]> = [
  [0, 3],
  [0, 3],
  [0, 3],
];

export interface Component {
  /** Pixel indices, row-major. */
  pixels: number[];
  left: number;
  top: number;
  width: number;
  height: number;
  area: number;
}

/** 8-connected components of the ones in a mask. */
export function components8(m: Mask): Component[] {
  const { w, h, data } = m;
  const seen = new Uint8Array(w * h);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!data[s] || seen[s]) continue;
    seen[s] = 1;
    stack.push(s);
    const pixels: number[] = [];
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    while (stack.length) {
      const k = stack.pop() ?? 0;
      pixels.push(k);
      const x = k % w;
      const y = (k - x) / w;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const n = ny * w + nx;
          if (data[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    out.push({
      pixels,
      left: x0,
      top: y0,
      width: x1 - x0 + 1,
      height: y1 - y0 + 1,
      area: pixels.length,
    });
  }
  return out;
}
