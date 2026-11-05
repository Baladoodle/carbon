/**
 * PNG bytes ↔ RgbaImage, over `fast-png` (pure JS: no Node, no DOM, no native
 * code), so main, the tests and the scripts share one codec. Callers do the
 * file I/O. Every PNG colour type and bit depth decodes to straight RGBA8;
 * 16-bit samples are rounded to 8 bits (v * 255 / 65535, half up).
 */
import { convertIndexedToRgb, decode, encode } from 'fast-png';
import { PixelError } from './errors';
import type { RgbaImage } from './types';

export function decodePng(bytes: Uint8Array): RgbaImage {
  let png;
  try {
    png = decode(bytes);
  } catch (e) {
    throw new PixelError(`not a readable PNG: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { width, height } = png;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  if (png.palette) {
    const rgb = convertIndexedToRgb(png);
    const c = png.palette[0]?.length === 4 ? 4 : 3;
    for (let i = 0; i < n; i++) {
      out[i * 4] = rgb[i * c] ?? 0;
      out[i * 4 + 1] = rgb[i * c + 1] ?? 0;
      out[i * 4 + 2] = rgb[i * c + 2] ?? 0;
      out[i * 4 + 3] = c === 4 ? (rgb[i * c + 3] ?? 255) : 255;
    }
    return { width, height, data: out };
  }
  const ch = png.channels;
  const depth = png.depth;
  const max = (1 << depth) - 1;
  const rowSamples = width * ch;
  const rowBytes = Math.ceil((rowSamples * depth) / 8);
  const sample = (y: number, s: number): number => {
    if (depth >= 8) return png.data[y * rowSamples + s] ?? 0;
    const bit = s * depth;
    const byte = png.data[y * rowBytes + (bit >> 3)] ?? 0;
    return (byte >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (v: number): number => (depth === 8 ? v : Math.floor((v * 255) / max + 0.5));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * ch;
      if (ch >= 3) {
        out[o] = to8(sample(y, s));
        out[o + 1] = to8(sample(y, s + 1));
        out[o + 2] = to8(sample(y, s + 2));
        out[o + 3] = ch === 4 ? to8(sample(y, s + 3)) : 255;
      } else {
        const g = to8(sample(y, s));
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = ch === 2 ? to8(sample(y, s + 1)) : 255;
      }
    }
  }
  return { width, height, data: out };
}

/** Encode as 8-bit RGBA, no ancillary chunks, so equal pixels give equal bytes. */
export function encodePng(img: RgbaImage): Uint8Array {
  if (img.data.length !== img.width * img.height * 4) {
    throw new PixelError(
      `image data has ${img.data.length} bytes, expected ${img.width * img.height * 4}`,
    );
  }
  return encode({
    width: img.width,
    height: img.height,
    data: new Uint8Array(img.data),
    channels: 4,
    depth: 8,
  });
}
