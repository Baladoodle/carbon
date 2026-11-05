import { getEntity, type World } from '../model/world';
import { artOf, ICON_CONVENTIONS, paletteWords } from './prompt';

/**
 * Icon sheets (docs/IMAGES.md §2a), the pure parts: each item's prompt line,
 * the sheet prompt built from the (possibly edited) lines, and splitting a
 * batch into sheets of at most 100.
 *
 * Lines are written here, deterministically, from the entity: a sheet of 100
 * needs no Claude call per item. The dialog shows them and they can be edited.
 */

export const SHEET_MAX = 100;

/** "Spore Lantern, a lantern (tool) made from Lumen Spore: light that breathes." */
export function sheetItemLine(world: World, entityId: string): string {
  const e = getEntity(world, entityId);
  if (!e) return entityId;
  const subkind = typeof e.fields.subkind === 'string' ? e.fields.subkind : undefined;
  const materials = [
    ...new Set(
      e.relations
        .filter((r) => r.type === 'made_from')
        .map((r) => getEntity(world, r.target)?.name)
        .filter((n): n is string => typeof n === 'string'),
    ),
  ];
  const what = [
    subkind ? `a ${subkind}` : `a ${e.kind}`,
    materials.length > 0 ? `made from ${materials.join(' and ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const identity = e.identity
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  return `${e.name}, ${what}${identity ? `: ${identity.charAt(0).toLowerCase()}${identity.slice(1)}` : ''}`.slice(
    0,
    300,
  );
}

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

/**
 * The sheet prompt: the house style once, then each cell by position. The
 * guide image (faint cell boxes) goes with it as the reference.
 */
export function sheetPrompt(
  world: World,
  lines: readonly string[],
  grid: { cols: number; rows: number },
  background = 'fully transparent',
): string {
  const palette = paletteWords(artOf(world).direction);
  const out = [
    `A sprite sheet of ${lines.length} separate game item icons on a ${grid.cols}×${grid.rows} grid, following the reference image's cell boxes exactly: one item per cell, in reading order (left to right, top to bottom).`,
    `Every item is centred in its cell with clear space around it, and no item crosses a cell edge. No text, no labels, no numbers, no grid lines in the result. Background: ${background}, the same everywhere.`,
    `House style for every item: ${ICON_CONVENTIONS.slice(0, 3).join(' ')}`,
    ...(palette ? [`Palette: ${palette}.`] : []),
    '',
    'The cells:',
    ...lines.map(
      (l, i) =>
        `row ${Math.floor(i / grid.cols) + 1}, col ${(i % grid.cols) + 1}: ${l.replace(/\s+/g, ' ').trim()}`,
    ),
  ];
  return out.join('\n');
}
