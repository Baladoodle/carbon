import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

/**
 * Pixels in main: RGBA buffers (the pixel filters' type) ⇄ PNG bytes, with
 * pngjs (pure JS, no native modules).
 */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Decodes a PNG of any colour type and bit depth to 8-bit RGBA. Throws on bytes that aren't a PNG. */
export function decodePng(bytes: Uint8Array): Rgba {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

/** Encodes RGBA as an 8-bit RGBA PNG. Deterministic: the same pixels give the same bytes. */
export function encodePng(img: Rgba): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height, colorType: 6 });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return new Uint8Array(PNG.sync.write(png, { colorType: 6 }));
}

/** True when the bytes start with the PNG signature. */
export const isPng = (b: Uint8Array): boolean =>
  b.length > 8 &&
  b[0] === 0x89 &&
  b[1] === 0x50 &&
  b[2] === 0x4e &&
  b[3] === 0x47 &&
  b[4] === 0x0d &&
  b[5] === 0x0a &&
  b[6] === 0x1a &&
  b[7] === 0x0a;

/**
 * Downscales by box averaging (alpha-weighted colour), keeping the aspect
 * ratio, so the longer side is at most `max`. Images already small enough are
 * returned unchanged.
 */
export function downscale(img: Rgba, max: number): Rgba {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  if (scale === 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const al = img.data[i + 3] as number;
          r += (img.data[i] as number) * al;
          g += (img.data[i + 1] as number) * al;
          b += (img.data[i + 2] as number) * al;
          a += al;
          n++;
        }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

export const dataUrl = (bytes: Uint8Array): string =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
