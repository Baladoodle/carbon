/**
 * Icon prompts in the house style of Genforge's `prompts/items/*.txt` (42 files,
 * studied in full; see docs/build-notes/pixel.md). Every Genforge item prompt is
 * one paragraph:
 *
 *   A single <subject> inventory icon[, <view>][: or ; <description>].
 *   [Diagonal presentation, <which end where>][; <material>].
 *   Short, exaggerated chunky proportions, large readable shapes, muted earthy
 *   colours, clean pixel-friendly illustration, flat even light, no shadow, no
 *   text, no border, no surrounding objects. Transparent background. Leave
 *   generous space around the silhouette.
 *
 * The closing conventions (`TAIL`) are verbatim; the art direction's palette
 * words replace "muted earthy colours" when there are any (IMAGES.md §5).
 * The sheet prompt follows Genforge's tile-sheet prompts (genforge/walls/prompts.py):
 * the guide's flat colours are named in words, nothing may move, the framing is
 * returned unchanged. Pure and deterministic.
 */
import type { Entity, World } from '../model';
import { GUIDE_NAMES } from './sheet';

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

/** Genforge's fixed closing conventions, with the colour phrase as a slot. */
export const TAIL =
  'Short, exaggerated chunky proportions, large readable shapes, {colours}, clean pixel-friendly illustration, flat even light, no shadow, no text, no border, no surrounding objects. Transparent background. Leave generous space around the silhouette.';
export const DEFAULT_COLOURS = 'muted earthy colours';

type Pose = { kind: 'diagonal' | 'view'; text: string };

/** How Genforge's prompts present each kind of object, keyed by words in the name or subkind. */
const POSES: Array<[RegExp, Pose]> = [
  [
    /\b(sword|blade|dagger|knife|sabre|saber|cutlass|rapier)\b/,
    {
      kind: 'diagonal',
      text: 'Diagonal presentation, the grip pointing bottom left and the blade top right',
    },
  ],
  [
    /\b(bow|crossbow)\b/,
    {
      kind: 'diagonal',
      text: 'Diagonal presentation, the bow arc bulging toward the top left, its tips at the top right and bottom left',
    },
  ],
  [
    /\b(axe|pickaxe|pick|shovel|spade|hammer|mallet|hoe|sickle|scythe|mace|club|tool)\b/,
    {
      kind: 'diagonal',
      text: 'Diagonal presentation, the stout handle pointing bottom left and the head top right',
    },
  ],
  [
    /\b(arrow|bolt|stick|wand|rod|staff|spear|torch)\b/,
    { kind: 'diagonal', text: 'Diagonal presentation from bottom left to top right' },
  ],
  [
    /\b(helmet|helm|hood|hat|cap|crown|mask)\b/,
    { kind: 'view', text: 'seen from the front at a slight three-quarter angle' },
  ],
  [
    /\b(chestplate|breastplate|armou?r|leggings|trousers|greaves|boots|gloves|gauntlets|cloak|tunic|shield)\b/,
    { kind: 'view', text: 'seen from the front' },
  ],
  [
    /\b(ingot|bar)\b/,
    { kind: 'view', text: 'a chunky trapezoid bar seen at a three-quarter angle from above' },
  ],
  [
    /\b(weapon)\b/,
    { kind: 'diagonal', text: 'Diagonal presentation from bottom left to top right' },
  ],
];

function pose(entity: IconSubject): Pose | null {
  const subkind = typeof entity.fields['subkind'] === 'string' ? entity.fields['subkind'] : '';
  // the name decides first ("Glass Lung" accessory vs "Ember Pickaxe" tool), then the subkind
  for (const text of [entity.name.toLowerCase(), subkind.toLowerCase()]) {
    for (const [re, p] of POSES) if (re.test(text)) return p;
  }
  return null;
}

/** Colour and tone words lifted from the art direction (IMAGES.md §5: "the direction's palette words"). */
const PALETTE_WORDS = new Set(
  (
    'muted saturated desaturated vivid pastel warm cool cold earthy earth tones tone dark pale bright dusky neon ' +
    'monochrome sepia ochre umber rust teal cyan blue green red crimson gold golden amber violet purple magenta pink ' +
    'orange yellow brown grey gray black white ivory bone copper brass silver jade emerald indigo scarlet olive slate charcoal'
  ).split(' '),
);

/** Phrases ("muted earth tones") of the direction made only of palette words, in order, deduplicated. */
export function paletteWords(direction: string | undefined): string[] {
  if (!direction) return [];
  const phrases: string[] = [];
  for (const clause of direction.toLowerCase().split(/[,;.\n]+/)) {
    let run: string[] = [];
    const flush = (): void => {
      if (run.length && !(run.length === 1 && /^tones?$/.test(run[0] ?? '')))
        phrases.push(run.join(' '));
      run = [];
    };
    for (const w of clause.split(/[^a-z-]+/).filter(Boolean)) {
      if (PALETTE_WORDS.has(w)) run.push(w);
      else flush();
    }
    flush();
  }
  return [...new Set(phrases)];
}

/** The colour phrase of the tail: Genforge's default, or the direction's palette words. */
export function colourPhrase(art: IconArt): string {
  const words = paletteWords(art.direction);
  if (!words.length) return DEFAULT_COLOURS;
  const list =
    words.length === 1
      ? (words[0] ?? '')
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
  return /\b(tones?|colou?rs?)$/.test(list) ? list : `${list} colours`;
}

const clean = (s: string): string =>
  s
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');

function firstSentence(s: string): string {
  const t = clean(s);
  const m = /^(.{1,240}?[.!?])(\s|$)/.exec(t);
  return clean(m?.[1] ?? t.slice(0, 240));
}
const lowerFirst = (s: string): string =>
  /^[A-Z](?![A-Z])/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;

function materials(entity: IconSubject, world: IconWorld): string[] {
  const entities: Readonly<Record<string, Pick<Entity, 'kind' | 'name'> | undefined>> =
    world.entities;
  return [
    ...new Set(
      entity.relations
        .filter((r) => r.type === 'made_from')
        .map((r) => entities[r.target]?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    ),
  ];
}
const andList = (xs: string[]): string =>
  xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1] ?? ''}`;

/** One entity's icon prompt, as one Genforge-style paragraph. */
export function iconPrompt(entity: IconSubject, world: IconWorld, art: IconArt = {}): string {
  const subkind =
    typeof entity.fields['subkind'] === 'string' ? entity.fields['subkind'] : undefined;
  const p = pose(entity);
  const mats = materials(entity, world).map((m) => m.toLowerCase());
  const detail = entity.description ? firstSentence(entity.description) : clean(entity.identity);
  let head = `A single ${clean(entity.name)} inventory icon`;
  if (p?.kind === 'view') head += `, ${p.text}`;
  if (detail) head += `${p?.kind === 'view' ? ';' : ':'} ${lowerFirst(detail)}`;
  else
    head += `, ${/^[aeiou]/i.test(subkind ?? entity.kind) ? 'an' : 'a'} ${subkind ?? entity.kind}`;
  const madeOf = mats.length ? `made of ${andList(mats)}` : '';
  const sentences: string[] = [];
  if (p?.kind === 'diagonal') {
    sentences.push(`${head}.`);
    sentences.push(`${p.text}${madeOf ? `; ${madeOf}` : ''}.`);
  } else {
    sentences.push(`${head}${madeOf ? `, ${madeOf}` : ''}.`);
  }
  const note = art.notes?.[entity.kind];
  if (note) sentences.push(`${clean(note).replace(/^./, (c) => c.toUpperCase())}.`);
  sentences.push(TAIL.replace('{colours}', colourPhrase(art)));
  return sentences.join(' ');
}

export interface SheetPromptOptions {
  /** The finished background: transparent where the model supports it, else one flat colour. */
  background?: string;
}

/** One cell's description: the item's own subject, view and material, in the house style's words. */
function cellLine(entity: IconSubject, world: IconWorld, row: number, col: number): string {
  const p = pose(entity);
  const mats = materials(entity, world).map((m) => m.toLowerCase());
  const detail = entity.description ? firstSentence(entity.description) : clean(entity.identity);
  const parts = [`row ${row + 1}, column ${col + 1}: a single ${clean(entity.name)}`];
  if (detail) parts.push(lowerFirst(detail));
  if (mats.length) parts.push(`made of ${andList(mats)}`);
  if (p) parts.push(p.kind === 'diagonal' ? lowerFirst(p.text) : p.text);
  return `- ${parts.join('; ')}.`;
}

/**
 * The prompt for one icon sheet (IMAGES.md §2a), sent with `drawGuide`'s image
 * as image 1: the guide's colours named, one item per MID-GREY square in reading
 * order, the house style once, then each cell by position.
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
  const { cell, gutter } = GUIDE_NAMES;
  const lines = [
    `Image 1 is a layout guide for a sheet of ${entities.length} separate game inventory icons, drawn in flat colours: each ${cell} square is one cell of a ${grid.cols}×${grid.rows} grid and the ${gutter} around them is empty gutter. Paint exactly one item, centred, inside each ${cell} square, in reading order. Do not move, add, remove or resize any square, and no item may touch or cross the edge of its square.`,
    `Every item: ${TAIL.replace('{colours}', colourPhrase(art)).replace(' Transparent background.', '')}`,
  ];
  for (const k of [...new Set(entities.map((e) => e.kind))]) {
    const note = art.notes?.[k];
    if (note) lines.push(`For every ${k}: ${clean(note)}.`);
  }
  lines.push(
    `The finished background is ${background} everywhere, between and inside the squares: do not draw the squares, the gutter, grid lines, labels or numbers. Leave no square empty.`,
    'The cells:',
  );
  entities.forEach((e, i) => {
    const c = grid.cells[i] ?? { row: 0, col: 0 };
    lines.push(cellLine(e, world, c.row, c.col));
  });
  lines.push('Return the same framing at the same size.');
  return lines.join('\n');
}
