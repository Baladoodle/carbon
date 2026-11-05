/**
 * Bit-exact emulation of the Pillow 12.3 operations Genforge's filters use
 * (src/libImaging/Resample.c, BoxBlur.c, Geometry.c, Convert.c), so the port
 * can match Genforge pixel for pixel. Each function names the C it follows;
 * integer and float32 arithmetic is reproduced where Pillow uses it.
 */

/** An 8-bit raster with 1 (L) or 4 (RGBA/RGBa) interleaved channels. */
export interface Raster {
  w: number;
  h: number;
  c: 1 | 4;
  data: Uint8Array;
}

export const raster = (w: number, h: number, c: 1 | 4): Raster => ({
  w,
  h,
  c,
  data: new Uint8Array(w * h * c),
});

const f32 = Math.fround;

export type Filter = 'box' | 'lanczos';

/** Resample.c filters. */
function filterFn(f: Filter): { fn: (x: number) => number; support: number } {
  if (f === 'box') return { fn: (x) => (x > -0.5 && x <= 0.5 ? 1.0 : 0.0), support: 0.5 };
  const sinc = (x: number): number => {
    if (x === 0.0) return 1.0;
    const px = x * Math.PI;
    return Math.sin(px) / px;
  };
  return { fn: (x) => (-3.0 <= x && x < 3.0 ? sinc(x) * sinc(x / 3) : 0.0), support: 3.0 };
}

const PRECISION_BITS = 32 - 8 - 2;

/** `precompute_coeffs` + `normalize_coeffs_8bpc`: fixed-point weights per output index. */
function coeffs(
  inSize: number,
  in0: number,
  in1: number,
  outSize: number,
  f: Filter,
): { ksize: number; bounds: Int32Array; kk: Int32Array } {
  const { fn, support: s } = filterFn(f);
  const scale = f32(f32(in1) - f32(in0)) / outSize;
  const filterscale = scale < 1.0 ? 1.0 : scale;
  const support = s * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Int32Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  const inv = 1.0 / filterscale;
  const k = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = in0 + (xx + 0.5) * scale;
    let ww = 0.0;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    k.fill(0);
    for (let x = 0; x < xmax; x++) {
      const w = fn((x + xmin - center + 0.5) * inv);
      k[x] = w;
      ww += w;
    }
    if (ww !== 0.0) for (let x = 0; x < xmax; x++) k[x] = (k[x] ?? 0) / ww;
    for (let x = 0; x < ksize; x++) {
      const v = k[x] ?? 0;
      kk[xx * ksize + x] =
        v < 0
          ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS))
          : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

const clip8 = (ss: number): number => {
  const v = ss >> PRECISION_BITS;
  return v < 0 ? 0 : v > 255 ? 255 : v;
};

/** `ImagingResampleInner`: two-pass (horizontal, then vertical) fixed-point resample. */
export function resample(src: Raster, xsize: number, ysize: number, f: Filter): Raster {
  // Pillow's default box is (0, 0, w, h), so `box[0] || box[2] != xsize` reduces to the size test.
  const box = [0, 0, src.w, src.h] as const;
  const needH = xsize !== src.w;
  const needV = ysize !== src.h;
  const vert = coeffs(src.h, box[1], box[3], ysize, f);
  let im = src;
  let yFirst = 0;
  if (needH) {
    yFirst = vert.bounds[0] ?? 0;
    const yLast = (vert.bounds[ysize * 2 - 2] ?? 0) + (vert.bounds[ysize * 2 - 1] ?? 0);
    const hz = coeffs(src.w, box[0], box[2], xsize, f);
    const c = src.c;
    const tmp = raster(xsize, yLast - yFirst, c);
    for (let yy = 0; yy < tmp.h; yy++) {
      const rowIn = (yy + yFirst) * src.w * c;
      const rowOut = yy * xsize * c;
      for (let xx = 0; xx < xsize; xx++) {
        const xmin = hz.bounds[xx * 2] ?? 0;
        const xmax = hz.bounds[xx * 2 + 1] ?? 0;
        const ko = xx * hz.ksize;
        for (let ch = 0; ch < c; ch++) {
          let ss = 1 << (PRECISION_BITS - 1);
          for (let x = 0; x < xmax; x++)
            ss += (src.data[rowIn + (x + xmin) * c + ch] ?? 0) * (hz.kk[ko + x] ?? 0);
          tmp.data[rowOut + xx * c + ch] = clip8(ss);
        }
      }
    }
    im = tmp;
  }
  if (!needV) return needH ? im : { ...src, data: src.data.slice() };
  const c = im.c;
  const out = raster(im.w, ysize, c);
  for (let yy = 0; yy < ysize; yy++) {
    const ymin = (vert.bounds[yy * 2] ?? 0) - (needH ? yFirst : 0);
    const ymax = vert.bounds[yy * 2 + 1] ?? 0;
    const ko = yy * vert.ksize;
    for (let xx = 0; xx < im.w; xx++) {
      for (let ch = 0; ch < c; ch++) {
        let ss = 1 << (PRECISION_BITS - 1);
        for (let y = 0; y < ymax; y++)
          ss += (im.data[((y + ymin) * im.w + xx) * c + ch] ?? 0) * (vert.kk[ko + y] ?? 0);
        out.data[(yy * im.w + xx) * c + ch] = clip8(ss);
      }
    }
  }
  return out;
}

/** `ImagingScaleAffine` (resize with NEAREST). */
export function nearest(src: Raster, xsize: number, ysize: number): Raster {
  const out = raster(xsize, ysize, src.c);
  const a0 = src.w / xsize;
  const a4 = src.h / ysize;
  const coord = (v: number): number => (v < 0.0 ? -1 : Math.trunc(v));
  const xintab = new Int32Array(xsize);
  let xo = 0 + a0 * 0.5;
  let xmin = xsize;
  let xmax = 0;
  for (let x = 0; x < xsize; x++) {
    const xin = coord(xo);
    if (xin >= 0 && xin < src.w) {
      xmax = x + 1;
      if (x < xmin) xmin = x;
      xintab[x] = xin;
    }
    xo += a0;
  }
  let yo = 0 + a4 * 0.5;
  for (let y = 0; y < ysize; y++) {
    const yi = coord(yo);
    if (yi >= 0 && yi < src.h) {
      for (let x = xmin; x < xmax; x++) {
        const s = (yi * src.w + (xintab[x] ?? 0)) * src.c;
        out.data.set(src.data.subarray(s, s + src.c), (y * xsize + x) * src.c);
      }
    }
    yo += a4;
  }
  return out;
}

/** Convert.c `rgbA2rgba`: straight → premultiplied (MULDIV255). */
export function premultiply(src: Raster): Raster {
  const out = { ...src, data: new Uint8Array(src.data.length) };
  const d = src.data;
  for (let p = 0; p < d.length; p += 4) {
    const a = d[p + 3] ?? 0;
    for (let c = 0; c < 3; c++) {
      const t = (d[p + c] ?? 0) * a + 128;
      out.data[p + c] = ((t >> 8) + t) >> 8;
    }
    out.data[p + 3] = a;
  }
  return out;
}

/** Convert.c `rgba2rgbA`: premultiplied → straight. */
export function unpremultiply(src: Raster): Raster {
  const out = { ...src, data: new Uint8Array(src.data.length) };
  const d = src.data;
  for (let p = 0; p < d.length; p += 4) {
    const a = d[p + 3] ?? 0;
    for (let c = 0; c < 3; c++) {
      const v = d[p + c] ?? 0;
      out.data[p + c] = a === 255 || a === 0 ? v : Math.min(255, Math.floor((255 * v) / a));
    }
    out.data[p + 3] = a;
  }
  return out;
}

/**
 * `Image.resize(size, resample)` as Pillow's Python layer does it: same size is a
 * copy; RGBA goes through premultiplied RGBa unless NEAREST; a same-size box crops.
 */
export function resize(src: Raster, w: number, h: number, f: Filter | 'nearest'): Raster {
  if (src.w === w && src.h === h) return { ...src, data: src.data.slice() };
  if (f === 'nearest') return nearest(src, w, h);
  if (src.c === 4) return unpremultiply(resample(premultiply(src), w, h, f));
  return resample(src, w, h, f);
}

/** BoxBlur.c `_gaussian_blur_radius` in float32. */
function gaussianBoxRadius(radius: number, passes: number): number {
  const r = f32(radius);
  const sigma2 = f32(f32(r * r) / passes);
  const L = f32(Math.sqrt(12.0 * sigma2 + 1.0));
  const l = f32(Math.floor((L - 1.0) / 2.0));
  let a = f32(f32(f32(2 * l) + 1) * f32(f32(l * f32(l + 1)) - f32(3 * sigma2)));
  const lp = f32(l + 1);
  a = f32(a / f32(6 * f32(sigma2 - f32(lp * lp))));
  return f32(l + a);
}

/**
 * BoxBlur.c `ImagingLineBoxBlur8` on `line[o .. o+n)` (in place via `tmp`).
 * UINT32 arithmetic: `bulk` never exceeds 255·2^24 (the weights sum to at most
 * 2^24), so `(bulk + 2^23) >>> 24` is exact in doubles.
 */
/** 2^-24: multiplying by it is exactly dividing by 2^24. */
const INV24 = 1 / 16777216;

function lineBoxBlur(
  line: Uint8Array,
  o: number,
  n: number,
  tmp: Uint8Array,
  radius: number,
  ww: number,
  fw: number,
): void {
  if (radius === 0) {
    // radius 0 (e.g. GaussianBlur(0.4)): the general loops reduce to a clamped 3-tap filter
    const last = n - 1;
    for (let x = 0; x < n; x++) {
      const l = line[o + (x > 0 ? x - 1 : 0)] as number;
      const r = line[o + (x < last ? x + 1 : last)] as number;
      tmp[x] = ((line[o + x] as number) * ww + (l + r) * fw + 8388608) * INV24;
    }
    line.set(tmp.subarray(0, n), o);
    return;
  }
  const lastx = n - 1;
  const edgeA = Math.min(radius + 1, n);
  const edgeB = Math.max(n - radius - 1, 0);
  const L = (i: number): number => line[o + i] as number;
  let acc = L(0) * (radius + 1);
  for (let x = 0; x < edgeA - 1; x++) acc += L(x);
  acc += L(lastx) * (radius - edgeA + 1);
  const first = L(0);
  const last = L(lastx);
  if (edgeA <= edgeB) {
    for (let x = 0; x < edgeA; x++) {
      acc += L(x + radius) - first;
      tmp[x] = (acc * ww + (first + L(x + radius + 1)) * fw + 8388608) * INV24;
    }
    for (let x = edgeA; x < edgeB; x++) {
      const sub = L(x - radius - 1);
      acc += L(x + radius) - sub;
      tmp[x] = (acc * ww + (sub + L(x + radius + 1)) * fw + 8388608) * INV24;
    }
    for (let x = edgeB; x <= lastx; x++) {
      const sub = L(x - radius - 1);
      acc += last - sub;
      tmp[x] = (acc * ww + (sub + last) * fw + 8388608) * INV24;
    }
  } else {
    for (let x = 0; x < edgeB; x++) {
      acc += L(x + radius) - first;
      tmp[x] = (acc * ww + (first + L(x + radius + 1)) * fw + 8388608) * INV24;
    }
    for (let x = edgeB; x < edgeA; x++) {
      acc += last - first;
      tmp[x] = (acc * ww + (first + last) * fw + 8388608) * INV24;
    }
    for (let x = edgeA; x <= lastx; x++) {
      const sub = L(x - radius - 1);
      acc += last - sub;
      tmp[x] = (acc * ww + (sub + last) * fw + 8388608) * INV24;
    }
  }
  // Uint8Array stores truncate the (non-negative) quotient: the C `>> 24`.
  line.set(tmp.subarray(0, n), o);
}

function transpose(d: Uint8Array, w: number, h: number): Uint8Array {
  const t = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) t[x * h + y] = d[o + x] as number;
  }
  return t;
}

/** `ImageFilter.GaussianBlur(radius)` on an L raster: 3 extended box-blur passes per axis. */
export function gaussianBlur(src: Raster, radius: number): Raster {
  if (src.c !== 1) throw new Error('gaussianBlur: L rasters only');
  if (radius === 0) return { ...src, data: src.data.slice() };
  const passes = 3;
  const fr = gaussianBoxRadius(radius, passes);
  const out = { ...src, data: src.data.slice() };
  if (src.w === 0 || src.h === 0 || fr === 0) return out;
  const ir = Math.trunc(fr);
  const ww = Math.trunc(f32(16777216 / f32(f32(fr * 2) + 1)));
  const fw = Math.floor((16777216 - (ir * 2 + 1) * ww) / 2);
  const { w, h } = src;
  const tmp = new Uint8Array(Math.max(w, h));
  for (let y = 0; y < h; y++)
    for (let i = 0; i < passes; i++) lineBoxBlur(out.data, y * w, w, tmp, ir, ww, fw);
  const t = transpose(out.data, w, h);
  for (let x = 0; x < w; x++)
    for (let i = 0; i < passes; i++) lineBoxBlur(t, x * h, h, tmp, ir, ww, fw);
  out.data.set(transpose(t, h, w));
  return out;
}
