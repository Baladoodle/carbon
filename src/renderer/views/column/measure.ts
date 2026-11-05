import type { Measure } from '@core/column/layout';

/**
 * Text width at the Column's chip font, measured on a canvas and cached. The
 * layout is pure and takes this as a parameter; tests pass a fake.
 */
export const CHIP_FONT = '400 12px "Inter Variable", Inter, sans-serif';
export const NOTE_FONT = '400 12px "Inter Variable", Inter, sans-serif';

const caches: Map<string, number>[] = [];

/** Forgets measured widths (after the fonts finish loading). */
export function resetMeasures(): void {
  for (const c of caches) c.clear();
}

function measurer(font: string): Measure {
  const cache = new Map<string, number>();
  caches.push(cache);
  let ctx: CanvasRenderingContext2D | null = null;
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    ctx ??= document.createElement('canvas').getContext('2d');
    if (!ctx) return text.length * 6.5;
    ctx.font = font;
    const w = ctx.measureText(text).width;
    if (cache.size > 20000) cache.clear();
    cache.set(text, w);
    return w;
  };
}

export const measureChip: Measure = measurer(CHIP_FONT);
export const measureNote: Measure = measurer(NOTE_FONT);
