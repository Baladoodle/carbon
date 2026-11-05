import type { PixelPreset, PixelSettings } from './types';

/** Genforge `genforge/plans.py` PRESETS, verbatim. `none` is `None`: a plain resample. */
export const PRESET_SETTINGS: Readonly<Record<PixelPreset, Readonly<PixelSettings> | null>> = {
  item: { downscale: 'item', colors: { count: 16 }, hairlines: true },
  sprite: { downscale: 'edge_preserving', colors: { count: 16, pick: 'variance' }, outline: 'rim' },
  texture: { downscale: 'area', colors: { count: 16, pick: 'variance' }, outline: 'none' },
  none: null,
};

/** Genforge revision of the ported source (src/core/pixel/UPSTREAM.json). */
export const UPSTREAM_REVISION = '52e6547bac6e4022abcc21e0820359ea3966a649';
