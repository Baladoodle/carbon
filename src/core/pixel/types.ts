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
 * Genforge filter settings (genforge/filters/__init__.py), the subset this port
 * implements. A `settings` object passed to `filterImage` REPLACES the preset's
 * settings, as Genforge's `--settings` does. Stages the port does not implement
 * (`before`, `vibrance`, `dither`, `noise`, `outline: outer`, `cleanup.symmetry`,
 * `alpha: smooth`, `downscale: median`) are rejected with a `PixelError`.
 */
export interface PixelSettings {
  downscale?: 'item' | 'source_aware' | 'edge_preserving' | 'area' | 'nearest';
  colors?: number | { count?: number; pick?: 'range' | 'variance'; palette?: string[] };
  outline?:
    | 'none'
    | 'inner'
    | 'hard'
    | 'rim'
    | { mode?: 'none' | 'inner' | 'hard' | 'rim'; darken?: number; color?: string };
  cleanup?: { stray?: boolean; min_cluster?: number };
  /** Alpha coverage threshold as a fraction (default 0.5 → 128). */
  alpha?: number;
  /** item path only */
  hairlines?: boolean;
  halo_floor?: number;
  crop_threshold?: number;
  blur?: number;
  alpha_threshold?: number;
  outline_darken?: number;
}

export interface FilterOptions {
  target: { w: number; h: number };
  preset: PixelPreset;
  /** Replaces the preset's settings (Genforge semantics). Ignored for `none` unless given. */
  settings?: PixelSettings;
}

export interface FilterReport {
  preset: PixelPreset;
  /** The settings that ran (`null`: Genforge's plain resample, preset `none`). */
  settings: PixelSettings | null;
  source: { w: number; h: number };
  target: { w: number; h: number };
  /** Distinct opaque colours in the output. */
  colors: number;
  /** Pixels with alpha 255 in the output. */
  opaquePixels: number;
  /** The Genforge revision this port matches (see UPSTREAM.json). */
  upstream: string;
}

export interface FilterResult {
  image: RgbaImage;
  report: FilterReport;
}
