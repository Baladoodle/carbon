import type { FieldDef } from './fields';
import { ITEM_SUBKINDS } from './kinds';
import type { KindDef, RelationTypeDef, WorldSchema } from './schema';

/**
 * The built-in kind schemas and relation types (docs/SYSTEM.md §3). This is
 * data: a world's `schema.json` can override or extend any of it, and the Bench,
 * Codex, validation and AI prompts are all driven from it.
 */

const text = (key: string, label: string, help?: string): FieldDef => ({
  key,
  label,
  type: 'text',
  ...(help ? { help } : {}),
});
const long = (key: string, label: string, help?: string): FieldDef => ({
  key,
  label,
  type: 'longtext',
  ...(help ? { help } : {}),
});

const band: KindDef = {
  kind: 'band',
  label: 'Band',
  plural: 'Bands',
  lane: null,
  help: 'A horizontal slice of the endless Y axis with its own character and danger.',
  fields: [
    {
      key: 'y_bottom',
      label: 'Bottom',
      type: 'height',
      help: 'Lower edge on Y; "-inf" for the endless depths',
    },
    {
      key: 'y_top',
      label: 'Top',
      type: 'height',
      help: 'Upper edge on Y; "+inf" for the endless sky',
    },
    text('character', 'Character', 'What being here feels like, in a line'),
    {
      key: 'danger',
      label: 'Danger',
      type: 'range',
      min: 0,
      help: 'How dangerous the band is, low to high',
    },
    text('air', 'Air'),
    text('light', 'Light'),
    text('hazard', 'Hazard'),
  ],
  attributes: [],
  required: {
    idea: [],
    shaped: ['identity', 'y_bottom', 'y_top', 'character'],
    decided: ['danger'],
  },
};

const biome: KindDef = {
  kind: 'biome',
  label: 'Biome',
  plural: 'Biomes',
  lane: 'biomes',
  help: 'A region of one band, placed on its temperature × moisture plane.',
  fields: [
    {
      key: 'band',
      label: 'Band',
      type: 'ref',
      refKinds: ['band'],
      help: 'The band this biome belongs to',
    },
    {
      key: 'climate',
      label: 'Climate',
      type: 'climate',
      help: 'Temperature and moisture ranges, 0..1',
      default: { temperature: { min: 0.4, max: 0.6 }, moisture: { min: 0.4, max: 0.6 } },
    },
    text('mood', 'Mood'),
    text('ground', 'Ground', 'What you stand on'),
    text('signature', 'Signature', 'The one thing you remember it by'),
  ],
  attributes: [],
  required: { idea: [], shaped: ['identity', 'band', 'climate', 'mood'], decided: ['signature'] },
};

const material: KindDef = {
  kind: 'material',
  label: 'Material',
  plural: 'Materials',
  lane: 'materials',
  help: 'Something found in the world and made into things.',
  fields: [
    {
      key: 'properties',
      label: 'Properties',
      type: 'list',
      help: 'Named qualities, e.g. "brittle", "glows"',
    },
    {
      key: 'rarity',
      label: 'Rarity',
      type: 'enum',
      options: ['common', 'uncommon', 'rare', 'legendary'],
    },
    text('processing', 'Processing', 'How it becomes useful'),
  ],
  attributes: [],
  required: { idea: [], shaped: ['identity', 'properties', 'rarity'], decided: [] },
};

const creature: KindDef = {
  kind: 'creature',
  label: 'Creature',
  plural: 'Creatures',
  lane: 'creatures',
  help: 'Something that lives in the world.',
  fields: [
    text('temperament', 'Temperament'),
    {
      key: 'menace',
      label: 'Menace',
      type: 'number',
      min: -1,
      max: 1,
      help: '−1 harmless … 1 deadly',
    },
    long('behaviour', 'Behaviour'),
    text('drops', 'Drops', 'What it leaves behind (the `drops` relations hold the materials)'),
  ],
  attributes: [],
  required: { idea: [], shaped: ['identity', 'temperament', 'menace', 'behaviour'], decided: [] },
};

const structure: KindDef = {
  kind: 'structure',
  label: 'Structure',
  plural: 'Structures',
  lane: 'structures',
  help: 'A built or grown place: ruins, nests, shrines.',
  fields: [
    text('purpose', 'Purpose'),
    { key: 'scale', label: 'Scale', type: 'enum', options: ['small', 'medium', 'large', 'vast'] },
    text('rewards', 'Rewards'),
  ],
  attributes: [],
  required: { idea: [], shaped: ['identity', 'purpose', 'scale'], decided: [] },
};

const capability: KindDef = {
  kind: 'capability',
  label: 'Capability',
  plural: 'Capabilities',
  lane: 'capabilities',
  help: 'Something the player can now do.',
  fields: [
    text('verb', 'Verb', 'What the player can now do, as a verb phrase'),
    text('gates', 'Gates', 'What it opens up'),
  ],
  attributes: [],
  required: { idea: [], shaped: ['identity', 'verb', 'gates'], decided: [] },
};

const item: KindDef = {
  kind: 'item',
  label: 'Item',
  plural: 'Items',
  lane: 'items',
  help: 'Armor, accessories, tools, weapons and consumables.',
  fields: [
    { key: 'subkind', label: 'Subkind', type: 'enum', options: [...ITEM_SUBKINDS] },
    text('slot', 'Slot'),
    text('change', 'Change', 'How the game changes when you have it'),
    text('tradeoff', 'Trade-off', 'What it costs you to use'),
    text('moment', 'Moment', 'The moment you first feel it'),
    { key: 'route', label: 'Route', type: 'steps', help: 'How you get it, step by step' },
  ],
  attributes: [
    { key: 'defense', label: 'Defense', min: 0, when: { subkind: 'armor' } },
    { key: 'damage', label: 'Damage', min: 0, when: { subkind: 'weapon' } },
  ],
  required: {
    idea: ['subkind'],
    shaped: ['identity', 'change', 'tradeoff'],
    decided: ['moment', 'route'],
  },
};

const feat: KindDef = {
  kind: 'feat',
  label: 'Feat',
  plural: 'Feats',
  lane: 'feats',
  help: 'A deed that reveals something and unlocks a capability or slot.',
  fields: [
    text('deed', 'Deed', 'What you do'),
    text('reveal', 'Reveal', 'What it shows you'),
    text('unlocks', 'Unlocks', 'In words (the `unlocks` relations hold the targets)'),
  ],
  attributes: [],
  required: { idea: [], shaped: ['identity', 'deed', 'reveal'], decided: [] },
};

const rel = (
  type: string,
  label: string,
  inverseLabel: string,
  from: RelationTypeDef['from'],
  to: RelationTypeDef['to'],
  extra: Partial<Pick<RelationTypeDef, 'symmetric' | 'acyclic' | 'help'>> = {},
): RelationTypeDef => ({
  type,
  label,
  inverseLabel,
  from,
  to,
  symmetric: extra.symmetric ?? false,
  acyclic: extra.acyclic ?? false,
  ...(extra.help ? { help: extra.help } : {}),
});

const NON_BAND = [
  'biome',
  'material',
  'creature',
  'structure',
  'capability',
  'item',
  'feat',
] as const;

const relations: RelationTypeDef[] = [
  rel('in_band', 'in band', 'contains', [...NON_BAND], ['band']),
  rel(
    'in_biome',
    'in biome',
    'contains',
    ['material', 'creature', 'structure', 'capability', 'item', 'feat'],
    ['biome'],
  ),
  rel('found_in', 'found in', 'yields', ['material'], ['biome', 'band']),
  rel('lives_in', 'lives in', 'home of', ['creature'], ['biome', 'band']),
  rel('made_from', 'made from', 'made into', ['item'], ['material']),
  rel('drops', 'drops', 'dropped by', ['creature'], ['material']),
  rel('requires', 'requires', 'required by', '*', ['capability', 'item']),
  rel('unlocks', 'unlocks', 'unlocked by', ['feat'], ['capability', 'item'], {
    help: 'A slot unlock is modelled as a capability (e.g. "Fourth accessory slot")',
  }),
  rel(
    'counters',
    'counters',
    'countered by',
    ['item', 'capability'],
    ['creature', 'band', 'biome'],
    {
      help: 'A hazard is countered through the band or biome that carries it',
    },
  ),
  rel('supersedes', 'supersedes', 'superseded by', ['item'], ['item'], { acyclic: true }),
  rel('conflicts', 'conflicts with', 'conflicts with', '*', '*', { symmetric: true }),
  rel('pairs_with', 'pairs with', 'pairs with', '*', '*', { symmetric: true }),
];

export const DEFAULT_SCHEMA: WorldSchema = {
  kinds: { band, biome, material, creature, structure, capability, item, feat },
  relations: Object.fromEntries(relations.map((r) => [r.type, r])),
};
