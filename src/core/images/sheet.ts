import { getEntity, type World } from '../model/world';
import type { Entity } from '../model/entity';
import { sheetPrompt as pixelSheetPrompt, type IconArt, type SheetLayout } from '../pixel';
import { artOf } from './prompt';

/**
 * Icon sheets (docs/IMAGES.md §2a), the parts images-core adds to pixel's
 * `sheetPrompt`: each cell's editable line, and splitting a batch into sheets
 * of at most 100.
 *
 * The prompt itself is pixel's (Genforge's tile-sheet prompt: the guide's
 * colours named, the house style once, `- row R, column C: …` per cell). The
 * batch dialog shows each cell's text after the position and lets you edit
 * it; `sheetPromptWithLines` puts edited text back in place of pixel's.
 */

export const SHEET_MAX = 100;

/** `world.settings.art` in pixel's shape. */
export function iconArt(world: World): IconArt {
  const art = artOf(world);
  return {
    ...(art.direction ? { direction: art.direction } : {}),
    notes: Object.fromEntries(
      Object.entries(art.kinds).filter(([, v]) => typeof v === 'string' && v !== ''),
    ),
  };
}

const CELL = /^- row (\d+), column (\d+): (.*?)\.?$/;

/** Splits items into sheets of at most `max`, as evenly as possible (230 → 77, 77, 76). */
export function splitSheets<T>(items: readonly T[], max = SHEET_MAX): T[][] {
  if (items.length === 0) return [];
  const sheets = Math.ceil(items.length / max);
  const out: T[][] = [];
  let at = 0;
  for (let i = 0; i < sheets; i++) {
    const n = Math.ceil((items.length - at) / (sheets - i));
    out.push(items.slice(at, at + n));
    at += n;
  }
  return out;
}

function entitiesOf(world: World, ids: readonly string[]): Entity[] {
  return ids.map((id) => {
    const e = getEntity(world, id);
    if (!e) throw new Error(`no entity "${id}"`);
    return e;
  });
}

/**
 * Pixel's sheet prompt for these entities, with each cell's text replaced by
 * `lines[i]` where one is given (an edit in the dialog).
 */
export function sheetPromptWithLines(
  world: World,
  ids: readonly string[],
  layout: SheetLayout,
  lines?: readonly (string | undefined)[],
): string {
  const base = pixelSheetPrompt(entitiesOf(world, ids), layout, world, iconArt(world));
  if (!lines) return base;
  return base
    .split('\n')
    .map((l) => {
      const m = CELL.exec(l);
      if (!m) return l;
      const row = Number(m[1]) - 1;
      const col = Number(m[2]) - 1;
      const i = layout.cells.findIndex((c) => c.row === row && c.col === col);
      const edited = lines[i]?.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
      return edited ? `- row ${row + 1}, column ${col + 1}: ${edited}.` : l;
    })
    .join('\n');
}

/** Each cell's text as pixel writes it (after "row R, column C: "), in cell order: what the dialog shows. */
export function sheetLines(world: World, ids: readonly string[], layout: SheetLayout): string[] {
  const out: string[] = ids.map(() => '');
  for (const l of sheetPromptWithLines(world, ids, layout).split('\n')) {
    const m = CELL.exec(l);
    if (!m) continue;
    const i = layout.cells.findIndex(
      (c) => c.row === Number(m[1]) - 1 && c.col === Number(m[2]) - 1,
    );
    if (i >= 0) out[i] = m[3] ?? '';
  }
  return out;
}
