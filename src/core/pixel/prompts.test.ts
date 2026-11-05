import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLOURS,
  TAIL,
  colourPhrase,
  iconPrompt,
  paletteWords,
  sheetPrompt,
} from './prompts';
import type { IconSubject } from './prompts';
import { sheetLayout } from './sheet';

const ITEMS = resolve(import.meta.dirname, '../../../upstream/genforge/prompts/items');
const world = {
  entities: {
    glass: { kind: 'material' as const, name: 'Lung Glass' },
    brass: { kind: 'material' as const, name: 'Deep Brass' },
    iron: { kind: 'material' as const, name: 'Iron' },
  },
};
const entity = (over: Partial<IconSubject>): IconSubject => ({
  id: 'x',
  kind: 'item',
  name: 'Thing',
  identity: '',
  description: '',
  fields: {},
  relations: [],
  ...over,
});

describe('the Genforge item house style', () => {
  const files = readdirSync(ITEMS).filter((f) => f.endsWith('.txt'));

  it('ends with the verbatim closing conventions of Genforge’s item prompts', () => {
    const tail = TAIL.replace('{colours}', DEFAULT_COLOURS);
    expect(files.length).toBe(42);
    const matching = files.filter((f) =>
      readFileSync(`${ITEMS}/${f}`, 'utf8').trim().endsWith(tail),
    );
    // wooden_bow alone swaps "large readable shapes" for "thick shapes, high contrast"
    expect(files.filter((f) => !matching.includes(f))).toEqual(['wooden_bow.txt']);
  });

  it('opens like every Genforge prompt: "A single … inventory icon"', () => {
    for (const f of files)
      expect(readFileSync(`${ITEMS}/${f}`, 'utf8')).toMatch(/^A single .*inventory icon/);
    expect(iconPrompt(entity({ name: 'Rift Cleaver' }), world)).toMatch(
      /^A single Rift Cleaver inventory icon/,
    );
  });

  it('reproduces Genforge’s iron sword prompt shape', () => {
    const p = iconPrompt(
      entity({
        name: 'iron short sword',
        description:
          'The broad blade and crossguard are dark grey forged iron, the grip wrapped in dark leather.',
        fields: { subkind: 'weapon' },
      }),
      world,
    );
    const genforge = readFileSync(`${ITEMS}/iron_sword.txt`, 'utf8').trim();
    // same opening, same presentation clause, same tail; the description is the entity's own
    expect(p.startsWith('A single iron short sword inventory icon')).toBe(true);
    expect(genforge).toContain(
      'Diagonal presentation, the grip pointing bottom left and the blade top right',
    );
    expect(p).toContain(
      'Diagonal presentation, the grip pointing bottom left and the blade top right.',
    );
    expect(p.endsWith(genforge.slice(genforge.indexOf('Short, exaggerated')))).toBe(true);
  });
});

describe('iconPrompt', () => {
  const lung = entity({
    id: 'glass-lung',
    name: 'Glass Lung',
    identity: 'breathe where the air is poison',
    description: 'A bellows of blown glass worn on the chest. It wheezes softly.\n\nMore lore.',
    fields: { subkind: 'accessory' },
    relations: [
      { type: 'made_from', target: 'glass' },
      { type: 'made_from', target: 'brass' },
      { type: 'made_from', target: 'glass' },
      { type: 'made_from', target: 'missing' },
      { type: 'in_band', target: 'brass' },
    ],
  });

  it('writes one paragraph: subject, description, materials, then the tail', () => {
    const p = iconPrompt(lung, world);
    expect(p).toBe(
      'A single Glass Lung inventory icon: a bellows of blown glass worn on the chest, made of lung glass and deep brass. ' +
        TAIL.replace('{colours}', DEFAULT_COLOURS),
    );
    expect(p).not.toContain('\n');
    expect(p).not.toContain('More lore');
  });

  it('presents tools, weapons, armour and ingots the way Genforge does', () => {
    const pick = iconPrompt(
      entity({ name: 'Ember Pickaxe', relations: [{ type: 'made_from', target: 'iron' }] }),
      world,
    );
    expect(pick).toContain(
      'A single Ember Pickaxe inventory icon, an item. Diagonal presentation, the stout handle pointing bottom left and the head top right; made of iron.',
    );
    expect(iconPrompt(entity({ name: 'Bone Helm' }), world)).toContain(
      'A single Bone Helm inventory icon, seen from the front at a slight three-quarter angle, an item.',
    );
    expect(
      iconPrompt(entity({ name: 'Moon Ingot', description: 'Faintly glowing.' }), world),
    ).toContain(
      'A single Moon Ingot inventory icon, a chunky trapezoid bar seen at a three-quarter angle from above; faintly glowing.',
    );
    expect(iconPrompt(entity({ name: 'Hunter', fields: { subkind: 'weapon' } }), world)).toContain(
      'Diagonal presentation from bottom left to top right.',
    );
    expect(iconPrompt(entity({ name: 'Yew Bow' }), world)).toContain(
      'the bow arc bulging toward the top left',
    );
    expect(iconPrompt(entity({ name: 'Ember Moss', kind: 'material' }), world)).toMatch(
      /^A single Ember Moss inventory icon, a material\. Short, exaggerated/,
    );
  });

  it('puts the art direction’s palette words in place of the default colours, and the kind’s art note', () => {
    const p = iconPrompt(lung, world, {
      direction: 'Painterly; cold blue and silver, soft rim light',
      notes: { item: 'chipped, well-used edges' },
    });
    expect(p).toContain(
      'large readable shapes, cold blue and silver colours, clean pixel-friendly',
    );
    expect(p).not.toContain(DEFAULT_COLOURS);
    expect(p).toContain('. Chipped, well-used edges. Short, exaggerated');
    expect(colourPhrase({ direction: 'muted earth tones' })).toBe('muted earth tones');
    expect(colourPhrase({})).toBe(DEFAULT_COLOURS);
  });

  it('is deterministic', () => {
    expect(iconPrompt(lung, world, { direction: 'warm ochre' })).toBe(
      iconPrompt(lung, world, { direction: 'warm ochre' }),
    );
  });
});

describe('paletteWords', () => {
  it('lifts colour phrases only', () => {
    expect(paletteWords(undefined)).toEqual([]);
    expect(
      paletteWords('Painterly; muted earth tones, gold and teal accents. Tones only.'),
    ).toEqual(['muted earth tones', 'gold', 'teal']);
  });
});

describe('sheetPrompt', () => {
  const items = [
    entity({ name: 'Pickaxe', relations: [{ type: 'made_from', target: 'iron' }] }),
    entity({ name: 'Orb', identity: 'sees through walls' }),
    entity({ name: 'Ash', kind: 'material' }),
  ];
  const l = sheetLayout(3, { w: 1024, h: 1024 });

  it('names the guide’s colours, keeps the framing, then lists each cell by position', () => {
    const p = sheetPrompt(
      items,
      l,
      world,
      { direction: 'warm ochre', notes: { item: 'worn' } },
      { background: 'flat pure white #FFFFFF' },
    );
    expect(p).toMatch(/^Image 1 is a layout guide for a sheet of 3 separate game inventory icons/);
    expect(p).toContain(
      'each MID-GREY square is one cell of a 2×2 grid and the DARK GREY around them is empty gutter',
    );
    expect(p).toContain('Do not move, add, remove or resize any square');
    expect(p).toContain(
      'Every item: Short, exaggerated chunky proportions, large readable shapes, warm ochre colours,',
    );
    expect(p).not.toContain('Transparent background.');
    expect(p).toContain('For every item: worn.');
    expect(p).toContain('The finished background is flat pure white #FFFFFF everywhere');
    expect(p).toContain(
      '- row 1, column 1: a single Pickaxe; made of iron; diagonal presentation, the stout handle pointing bottom left and the head top right.',
    );
    expect(p).toContain('- row 1, column 2: a single Orb; sees through walls.');
    expect(p).toContain('- row 2, column 1: a single Ash.');
    expect(p.endsWith('Return the same framing at the same size.')).toBe(true);
    expect(sheetPrompt(items, l, world)).toContain(
      'The finished background is fully transparent everywhere',
    );
  });

  it('rejects a mismatched grid', () => {
    expect(() => sheetPrompt([items[0]!], sheetLayout(2, { w: 256, h: 256 }), world)).toThrow(
      /cells/,
    );
  });
});
