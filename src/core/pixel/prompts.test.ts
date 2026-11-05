import { describe, expect, it } from 'vitest';
import { iconPrompt, paletteWords } from './prompts';
import type { IconSubject } from './prompts';

const world = {
  entities: {
    glass: { kind: 'material' as const, name: 'Lung Glass' },
    brass: { kind: 'material' as const, name: 'Deep Brass' },
  },
};

const lung: IconSubject = {
  id: 'glass-lung',
  kind: 'item',
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
};

describe('iconPrompt', () => {
  it('covers every house-style section, in order', () => {
    const p = iconPrompt(lung, world, {
      direction: 'painterly, muted earth tones, soft rim light',
    });
    const heads = p.split('\n').map((l) => l.split(':')[0]);
    expect(heads).toEqual([
      'Subject',
      'Details',
      'Presentation',
      'Proportions',
      'Materials',
      'Palette',
      'Light',
      'Background',
      'Never',
    ]);
    expect(p).toContain('Subject: Glass Lung, an accessory: breathe where the air is poison.');
    expect(p).toContain('Details: A bellows of blown glass worn on the chest.');
    expect(p).not.toContain('More lore');
    expect(p).toContain('made from Lung Glass, Deep Brass;');
    expect(p).toContain('Palette: muted earth tones.');
    expect(p).toMatch(/transparent/);
    expect(p).toMatch(/no cast shadow/);
    expect(p).toMatch(/text, letters/);
    expect(p).toMatch(/empty space around its whole silhouette/);
  });

  it('is deterministic and handles a bare entity', () => {
    const bare: IconSubject = {
      id: 'x',
      kind: 'material',
      name: '  Ash  ',
      identity: '',
      description: '',
      fields: {},
      relations: [],
    };
    const a = iconPrompt(bare, { entities: {} });
    expect(a).toBe(iconPrompt(bare, { entities: {} }));
    expect(a).toContain('Subject: Ash, a material.');
    expect(a).not.toContain('Details');
    expect(a).not.toContain('Palette');
    expect(a).toContain('upright and facing the viewer');
    expect(a).toContain('Materials: a few large');
  });

  it('presents weapons diagonally and adds the per-kind art note', () => {
    const p = iconPrompt({ ...lung, fields: { subkind: 'weapon' }, relations: [] }, world, {
      notes: { item: 'chipped edges.' },
    });
    expect(p).toContain('diagonal from lower left to upper right, grip');
    expect(p).toContain('Art note: chipped edges.');
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
