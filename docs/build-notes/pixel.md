# Build notes: pixel

## API (stable; images-core depends on it)

```ts
import { filterImage, decodePng, encodePng, iconPrompt } from '@core/pixel';

const src = decodePng(bytes);                       // Uint8Array (main reads the file) → RgbaImage
const { image, report } = filterImage(src, {
  target: { w: 16, h: 16 },
  preset: 'item',                                   // 'item' | 'sprite' | 'texture' | 'none'
  settings: { paletteSize: 12 },                    // optional per-call overrides
});
const out = encodePng(image);                       // → Uint8Array (main writes it atomically)
```

- `RgbaImage = { width, height, data: Uint8ClampedArray }`, straight RGBA8, row-major.
- `filterImage` is pure and deterministic. It throws `PixelError` on bad input
  (size mismatch, non-integer or out-of-range target, unknown preset, bad settings).
- `report`: `{ preset, settings (resolved), source, target, colors, opaquePixels, provisional, upstream }`.
  **`report.provisional === true` means the output is not yet the verified
  Genforge port**; store `report.settings` in `ImageMeta.origin.settings`.
- `iconPrompt(entity, world, art?) → string`: `Entity`/`World` from `@core/model`
  are assignable; `art` is `world.settings.art` (`{ direction?, notes? }`).

_Status and the rest of these notes follow below._
