/**
 * The pixel filter contract (docs/IMAGES.md §2). Everything here is pure: RGBA
 * buffers in, RGBA buffers out, no I/O, no clock, no randomness.
 */

/** A straight (non-premultiplied) RGBA8 image, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export const PIXEL_PRESETS = ['item', 'sprite', 'texture', 'none'] as const;
export type PixelPreset = (typeof PIXEL_PRESETS)[number];

/**
 * Per-call overrides of a preset's settings. Every field is optional; a missing
 * field takes the preset's value (`PRESET_SETTINGS`).
 */
export interface PixelSettings {
  /** Resample in linear light (sRGB decoded) rather than on gamma-encoded bytes. */
  linearLight?: boolean;
  /** Alpha at or above this (0..1) becomes opaque, below it transparent. `null` keeps soft alpha. */
  alphaThreshold?: number | null;
  /** Bleed opaque colour into transparent pixels before resampling, so edges carry no dark halo. */
  haloFix?: boolean;
  /** Maximum colours in the output palette (opaque pixels). `null` disables quantization. */
  paletteSize?: number | null;
  /** Darken the outermost opaque ring by this fraction (0..1). 0 disables the rim. */
  rim?: number;
  /** The source tiles: sample with wrap-around and force opaque output. */
  tileable?: boolean;
}

export type ResolvedPixelSettings = Required<PixelSettings>;

export interface FilterOptions {
  target: { w: number; h: number };
  preset: PixelPreset;
  settings?: PixelSettings;
}

export interface FilterReport {
  preset: PixelPreset;
  settings: ResolvedPixelSettings;
  source: { w: number; h: number };
  target: { w: number; h: number };
  /** Distinct opaque colours in the output. */
  colors: number;
  /** Pixels with alpha 255 in the output. */
  opaquePixels: number;
  /**
   * `true` while this is carbon's own filter rather than the verified Genforge
   * port (see docs/build-notes/pixel.md). Outputs may change when the port lands.
   */
  provisional: boolean;
  /** Genforge revision this port matches, when known. */
  upstream: string | null;
}

export interface FilterResult {
  image: RgbaImage;
  report: FilterReport;
}
