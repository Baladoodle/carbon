/**
 * The icon prompt template (docs/IMAGES.md §2, §5).
 *
 * PROVISIONAL wording. It follows the conventions IMAGES.md lists for
 * Genforge's `prompts/items/*.txt` (subject, presentation, proportions,
 * materials, flat light, transparent background, no text/border/shadow, space
 * around the silhouette), but the house-style files themselves could not be
 * read, so the phrasing is carbon's (docs/build-notes/pixel.md, "Status").
 *
 * Pure and deterministic: same inputs, same string.
 */
import type { Entity, World } from '../model';

/** The parts of an entity the prompt uses. `Entity` is assignable. */
export type IconSubject = Pick<
  Entity,
  'id' | 'kind' | 'name' | 'identity' | 'description' | 'fields' | 'relations'
>;
/** The parts of a world the prompt uses. `World` is assignable. */
export type IconWorld =
  { entities: Readonly<Record<string, Pick<Entity, 'kind' | 'name'>>> } | Pick<World, 'entities'>;
/** `world.settings.art` (IMAGES.md §5). */
export interface IconArt {
  direction?: string;
  notes?: Readonly<Record<string, string>>;
}

/** How each item subkind is presented on its 16×16 tile. */
const PRESENTATION: Readonly<Record<string, string>> = {
  weapon: 'shown alone, diagonal from lower left to upper right, grip at the bottom left',
  tool: 'shown alone, diagonal from lower left to upper right, handle at the bottom left',
  armor: 'shown alone and upright, facing the viewer, as if on an invisible stand',
  accessory: 'shown alone, upright and facing the viewer',
  consumable: 'shown alone, upright, slightly from above',
};
const DEFAULT_PRESENTATION = 'shown alone, upright and facing the viewer';

/** Colour and tone words lifted from the art direction (IMAGES.md §5: "the direction's palette words"). */
const PALETTE_WORDS = new Set([
  'muted',
  'saturated',
  'desaturated',
  'vivid',
  'pastel',
  'warm',
  'cool',
  'cold',
  'earthy',
  'earth',
  'tones',
  'tone',
  'dark',
  'pale',
  'bright',
  'dusky',
  'neon',
  'monochrome',
  'sepia',
  'ochre',
  'umber',
  'rust',
  'teal',
  'cyan',
  'blue',
  'green',
  'red',
  'crimson',
  'gold',
  'golden',
  'amber',
  'violet',
  'purple',
  'magenta',
  'pink',
  'orange',
  'yellow',
  'brown',
  'grey',
  'gray',
  'black',
  'white',
  'ivory',
  'bone',
  'copper',
  'brass',
  'silver',
  'jade',
  'emerald',
  'indigo',
  'scarlet',
  'olive',
  'slate',
  'charcoal',
]);

/** Phrases ("muted earth tones") of the direction made only of palette words, in order, deduplicated. */
export function paletteWords(direction: string | undefined): string[] {
  if (!direction) return [];
  const phrases: string[] = [];
  for (const clause of direction.toLowerCase().split(/[,;.\n]+/)) {
    const words = clause.split(/[^a-z-]+/).filter(Boolean);
    let run: string[] = [];
    const flush = (): void => {
      // A lone "tones"/"tone" carries no colour.
      if (run.length && !(run.length === 1 && /^tones?$/.test(run[0] ?? '')))
        phrases.push(run.join(' '));
      run = [];
    };
    for (const w of words) {
      if (PALETTE_WORDS.has(w)) run.push(w);
      else flush();
    }
    flush();
  }
  return [...new Set(phrases)];
}

const clean = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');

function firstSentence(s: string): string {
  const t = clean(s.replace(/[#*_`>]/g, ''));
  const m = /^(.{1,240}?[.!?])(\s|$)/.exec(t);
  return clean(m?.[1] ?? t.slice(0, 240));
}

export function iconPrompt(entity: IconSubject, world: IconWorld, art: IconArt = {}): string {
  const subkind =
    typeof entity.fields['subkind'] === 'string' ? entity.fields['subkind'] : undefined;
  const noun = subkind ? subkind : entity.kind;
  const entities: Readonly<Record<string, Pick<Entity, 'kind' | 'name'> | undefined>> =
    world.entities;
  const materials = [
    ...new Set(
      entity.relations
        .filter((r) => r.type === 'made_from')
        .map((r) => entities[r.target]?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    ),
  ];

  const lines: string[] = [];
  const identity = entity.identity ? `: ${clean(entity.identity)}` : '';
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a';
  lines.push(`Subject: ${clean(entity.name)}, ${article} ${noun}${identity}.`);
  if (entity.description) lines.push(`Details: ${firstSentence(entity.description)}.`);
  lines.push(
    `Presentation: a single game inventory icon of the ${noun}, ${PRESENTATION[subkind ?? ''] ?? DEFAULT_PRESENTATION}, centred.`,
  );
  lines.push(
    'Proportions: chunky and simplified, a bold readable silhouette that still reads at 16×16 pixels; exaggerate the one defining feature and drop fine detail.',
  );
  lines.push(
    materials.length
      ? `Materials: made from ${materials.join(', ')}; show each as a few large, clearly separated areas of flat colour.`
      : 'Materials: a few large, clearly separated areas of flat colour, each material distinct.',
  );
  const palette = paletteWords(art.direction);
  if (palette.length) lines.push(`Palette: ${palette.join(', ')}.`);
  const note = art.notes?.[entity.kind];
  if (note) lines.push(`Art note: ${clean(note)}.`);
  lines.push(
    'Light: flat, even front light; no cast shadow, no glow, no reflections, no gradient background.',
  );
  lines.push(
    'Background: fully transparent. The object fills about 80% of the frame with clear empty space around its whole silhouette; nothing touches or crosses the edges.',
  );
  lines.push(
    'Never: text, letters, numbers, labels, borders, frames, outlines around the canvas, drop shadows, or a second object.',
  );
  return lines.join('\n');
}

export interface SheetPromptOptions {
  /** A flat background colour (e.g. "flat pure white #FFFFFF"), or transparent when the model supports it. */
  background?: string;
}

/** One line per cell: "row 1, col 2: Glass Lung, an accessory of Lung Glass (breathe where …), upright". */
function cellLine(entity: IconSubject, world: IconWorld, row: number, col: number): string {
  const subkind =
    typeof entity.fields['subkind'] === 'string' ? entity.fields['subkind'] : undefined;
  const noun = subkind ?? entity.kind;
  const entities: Readonly<Record<string, Pick<Entity, 'kind' | 'name'> | undefined>> =
    world.entities;
  const materials = [
    ...new Set(
      entity.relations
        .filter((r) => r.type === 'made_from')
        .map((r) => entities[r.target]?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    ),
  ];
  const of = materials.length ? ` of ${materials.join(' and ')}` : '';
  const identity = entity.identity ? ` (${clean(entity.identity)})` : '';
  const pose = (PRESENTATION[subkind ?? ''] ?? DEFAULT_PRESENTATION).replace(/^shown alone, /, '');
  return `row ${row + 1}, col ${col + 1}: ${clean(entity.name)}, a chunky ${noun}${of}${identity}, ${pose}.`;
}

/**
 * The prompt for one icon sheet (IMAGES.md §2a): the item house style once, then
 * each cell by position. `cells[i]` is the grid position of `entities[i]`.
 */
export function sheetPrompt(
  entities: readonly IconSubject[],
  grid: { cols: number; rows: number; cells: readonly { row: number; col: number }[] },
  world: IconWorld,
  art: IconArt = {},
  opts: SheetPromptOptions = {},
): string {
  if (entities.length !== grid.cells.length) {
    throw new Error(`sheetPrompt: ${entities.length} items for ${grid.cells.length} cells`);
  }
  const background = opts.background ?? 'fully transparent';
  const lines: string[] = [
    `A sprite sheet of ${entities.length} separate game inventory icons on a ${grid.cols}×${grid.rows} grid, following the reference image's cell boxes exactly; one item per cell, in reading order.`,
    'Each item: chunky and simplified, a bold readable silhouette that still reads at 16×16 pixels; a few large, clearly separated areas of flat colour per material; exaggerate the one defining feature.',
  ];
  const palette = paletteWords(art.direction);
  if (palette.length) lines.push(`Palette: ${palette.join(', ')}.`);
  const kinds = [...new Set(entities.map((e) => e.kind))];
  for (const k of kinds) {
    const note = art.notes?.[k];
    if (note) lines.push(`Art note (${k}): ${clean(note)}.`);
  }
  lines.push(
    'Light: flat, even front light; no cast shadow, no glow, no reflections.',
    `Background: ${background}, the same everywhere, including between cells. Every item is centred in its own cell with clear empty space around its whole silhouette; no item touches or crosses a cell edge.`,
    'Never: text, letters, numbers, labels, captions, borders, frames, visible grid lines, drop shadows, or a second object in a cell. Leave no cell empty.',
    'Cells:',
  );
  entities.forEach((e, i) => {
    const c = grid.cells[i] ?? { row: 0, col: 0 };
    lines.push(cellLine(e, world, c.row, c.col));
  });
  return lines.join('\n');
}
