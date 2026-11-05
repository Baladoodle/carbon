import { downscale, type Rgba } from './png';

/**
 * The pixel filter, behind one function so the real port can drop in.
 *
 * ADAPTER: Genforge's filters are being ported to `src/core/pixel/` (the
 * pixel package) as `filterImage(src, { target, preset })`. Until that
 * merges, this stands in with the same signature and a simple `item`
 * preset: crop to the opaque area, pad to a square, box-downscale to the
 * target, then hard alpha (Infinite's icons have no partial transparency)
 * and a 32-level colour quantise. When the port lands, replace the body of
 * `filterImage` with a call to it; nothing else changes.
 */
export interface FilterOptions {
  /** Output size in pixels (icons: 16). */
  target: number;
  preset: 'item' | 'sprite' | 'texture' | 'none';
}

export const FILTER_SOURCE = 'images-core adapter (src/main/images/pixel.ts)';

/** The opaque bounding box (alpha ≥ 16), or the whole image when it's opaque everywhere or empty. */
function opaqueBox(img: Rgba): { x: number; y: number; w: number; h: number } {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if ((img.data[(y * img.width + x) * 4 + 3] as number) >= 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { x: 0, y: 0, w: img.width, h: img.height };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A square crop of `img` centred on `box`, transparent outside the image. */
function squareAround(img: Rgba, box: { x: number; y: number; w: number; h: number }): Rgba {
  const side = Math.max(box.w, box.h);
  const ox = box.x - Math.floor((side - box.w) / 2);
  const oy = box.y - Math.floor((side - box.h) / 2);
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const sx = ox + x;
      const sy = oy + y;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      const i = (sy * img.width + sx) * 4;
      out.set(img.data.subarray(i, i + 4), (y * side + x) * 4);
    }
  return { width: side, height: side, data: out };
}

export function filterImage(src: Rgba, opts: FilterOptions): Rgba {
  if (opts.preset === 'none') return downscale(src, opts.target);
  const sq = squareAround(src, opaqueBox(src));
  const small = downscale(sq, opts.target);
  // Exactly target × target, even from a 1px source.
  const out = new Uint8ClampedArray(opts.target * opts.target * 4);
  for (let y = 0; y < opts.target; y++)
    for (let x = 0; x < opts.target; x++) {
      const sx = Math.min(small.width - 1, Math.floor((x * small.width) / opts.target));
      const sy = Math.min(small.height - 1, Math.floor((y * small.height) / opts.target));
      const i = (sy * small.width + sx) * 4;
      const o = (y * opts.target + x) * 4;
      const opaque = (small.data[i + 3] as number) >= 128;
      for (let c = 0; c < 3; c++)
        out[o + c] = opaque ? Math.round((small.data[i + c] as number) / 8) * 8 : 0;
      out[o + 3] = opaque ? 255 : 0;
    }
  return { width: opts.target, height: opts.target, data: out };
}
