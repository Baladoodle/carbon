import { PixelError } from './errors';
import type { PixelPreset, PixelSettings, ResolvedPixelSettings } from './types';

/**
 * Preset settings. PROVISIONAL values chosen by carbon, not read from Genforge
 * (see docs/build-notes/pixel.md): the port replaces them with Genforge's.
 */
export const PRESET_SETTINGS: Readonly<Record<PixelPreset, Readonly<ResolvedPixelSettings>>> = {
  item: {
    linearLight: true,
    alphaThreshold: 0.5,
    haloFix: true,
    paletteSize: 16,
    rim: 0.25,
    tileable: false,
  },
  sprite: {
    linearLight: true,
    alphaThreshold: 0.5,
    haloFix: true,
    paletteSize: 32,
    rim: 0,
    tileable: false,
  },
  texture: {
    linearLight: true,
    alphaThreshold: null,
    haloFix: false,
    paletteSize: 32,
    rim: 0,
    tileable: true,
  },
  none: {
    linearLight: false,
    alphaThreshold: null,
    haloFix: false,
    paletteSize: null,
    rim: 0,
    tileable: false,
  },
};

export function resolveSettings(
  preset: PixelPreset,
  over: PixelSettings | undefined,
): ResolvedPixelSettings {
  const s: ResolvedPixelSettings = { ...PRESET_SETTINGS[preset], ...stripUndefined(over ?? {}) };
  if (s.alphaThreshold !== null && !(s.alphaThreshold >= 0 && s.alphaThreshold <= 1)) {
    throw new PixelError(`alphaThreshold must be in 0..1 or null, got ${s.alphaThreshold}`);
  }
  if (
    s.paletteSize !== null &&
    !(Number.isInteger(s.paletteSize) && s.paletteSize >= 1 && s.paletteSize <= 256)
  ) {
    throw new PixelError(`paletteSize must be an integer in 1..256 or null, got ${s.paletteSize}`);
  }
  if (!(s.rim >= 0 && s.rim <= 1)) throw new PixelError(`rim must be in 0..1, got ${s.rim}`);
  return s;
}

function stripUndefined(o: PixelSettings): PixelSettings {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
