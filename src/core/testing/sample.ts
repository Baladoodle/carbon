import { EntitySchema, type Entity, type EntityInput } from '../model/entity';
import { emptyWorld, type World } from '../model/world';

/**
 * The sample world: a few bands and biomes and entities of every kind, in every
 * state, using every relation type. For tests and screenshots only — it is not
 * design content for Infinite. `fixtures/worlds/sample/` is generated from this
 * (`npm run fixtures:sample`), and a store test checks the two agree.
 */
export const SAMPLE_TIME = '2026-11-01T12:00:00.000Z';

const e = (input: Omit<EntityInput, 'created' | 'updated'>): Entity =>
  EntitySchema.parse({ created: SAMPLE_TIME, updated: SAMPLE_TIME, ...input });

const ENTITIES: Entity[] = [
  // Bands, from the endless depths to the endless sky.
  e({
    id: 'undercroft',
    kind: 'band',
    name: 'Undercroft',
    state: 'shaped',
    identity: 'Pressure, heat and old stone without end.',
    fields: {
      y_bottom: '-inf',
      y_top: -512,
      character: 'Close, hot and ancient',
      danger: { min: 6, max: 10 },
      hazard: 'crushing heat',
    },
  }),
  e({
    id: 'hollows',
    kind: 'band',
    name: 'Hollows',
    state: 'decided',
    identity: 'Caverns big enough to have weather.',
    why: 'The first place the world feels deep.',
    fields: {
      y_bottom: -512,
      y_top: -64,
      character: 'Echoing and damp',
      danger: { min: 3, max: 6 },
      light: 'fungal glow',
    },
  }),
  e({
    id: 'groundline',
    kind: 'band',
    name: 'Groundline',
    state: 'decided',
    identity: 'Where everyone starts.',
    why: 'Home base.',
    fields: {
      y_bottom: -64,
      y_top: 96,
      character: 'Open and readable',
      danger: { min: 0, max: 2 },
    },
  }),
  e({
    id: 'low-sky',
    kind: 'band',
    name: 'Low Sky',
    state: 'shaped',
    identity: 'Floating islands in thinning air.',
    fields: {
      y_bottom: 96,
      y_top: 640,
      character: 'Bright and exposed',
      danger: { min: 2, max: 5 },
      air: 'thin',
    },
  }),
  e({
    id: 'high-drift',
    kind: 'band',
    name: 'High Drift',
    state: 'idea',
    identity: 'Debris orbiting nothing.',
    fields: { y_bottom: 640, y_top: '+inf' },
  }),
  // Biomes.
  e({
    id: 'glowmoss-caverns',
    kind: 'biome',
    name: 'Glowmoss Caverns',
    state: 'shaped',
    identity: 'Soft light on wet stone.',
    fields: {
      band: 'hollows',
      climate: { temperature: { min: 0.3, max: 0.55 }, moisture: { min: 0.6, max: 0.95 } },
      mood: 'hushed',
      ground: 'spongy moss',
      signature: 'moss that dims when you shout',
    },
  }),
  e({
    id: 'ash-vents',
    kind: 'biome',
    name: 'Ash Vents',
    state: 'idea',
    identity: 'Chimneys breathing grey heat.',
    fields: {
      band: 'hollows',
      climate: { temperature: { min: 0.75, max: 1 }, moisture: { min: 0, max: 0.25 } },
    },
  }),
  e({
    id: 'meadow-steps',
    kind: 'biome',
    name: 'Meadow Steps',
    state: 'decided',
    identity: 'Terraced grass, gentle and open.',
    why: 'A calm first biome.',
    fields: {
      band: 'groundline',
      climate: { temperature: { min: 0.4, max: 0.7 }, moisture: { min: 0.35, max: 0.7 } },
      mood: 'calm',
      ground: 'grass terraces',
      signature: 'stone steps nobody built',
    },
  }),
  e({
    id: 'cloud-reef',
    kind: 'biome',
    name: 'Cloud Reef',
    state: 'shaped',
    identity: 'Coral that grows on condensed cloud.',
    fields: {
      band: 'low-sky',
      climate: { temperature: { min: 0.2, max: 0.45 }, moisture: { min: 0.55, max: 0.9 } },
      mood: 'airy',
      ground: 'cloud coral',
    },
  }),
  // Materials.
  e({
    id: 'lumen-spore',
    kind: 'material',
    name: 'Lumen Spore',
    state: 'shaped',
    identity: 'A spore that stores light.',
    fields: {
      properties: ['glows', 'fragile'],
      rarity: 'common',
      processing: 'pressed into paste',
    },
    relations: [{ type: 'found_in', target: 'glowmoss-caverns' }],
  }),
  e({
    id: 'vent-glass',
    kind: 'material',
    name: 'Vent Glass',
    state: 'idea',
    identity: 'Glass blown by the earth itself.',
    fields: { properties: ['brittle', 'heat-proof'], rarity: 'uncommon' },
    relations: [{ type: 'found_in', target: 'ash-vents' }],
  }),
  e({
    id: 'sky-coral',
    kind: 'material',
    name: 'Sky Coral',
    state: 'idea',
    identity: 'Light as foam, strong as bone.',
    fields: { rarity: 'rare' },
  }),
  // Creatures.
  e({
    id: 'moss-grazer',
    kind: 'creature',
    name: 'Moss Grazer',
    state: 'shaped',
    identity: 'A slow, glowing herd animal.',
    fields: { temperament: 'timid', menace: -0.6, behaviour: 'Grazes moss; scatters at noise.' },
    relations: [
      { type: 'lives_in', target: 'glowmoss-caverns' },
      { type: 'drops', target: 'lumen-spore' },
    ],
  }),
  e({
    id: 'cinder-wasp',
    kind: 'creature',
    name: 'Cinder Wasp',
    state: 'idea',
    identity: 'Swarms that nest in vent chimneys.',
    fields: { temperament: 'territorial', menace: 0.5 },
    relations: [
      { type: 'lives_in', target: 'ash-vents' },
      { type: 'drops', target: 'vent-glass' },
    ],
  }),
  e({
    id: 'reef-ray',
    kind: 'creature',
    name: 'Reef Ray',
    state: 'graveyard',
    identity: 'A manta that swims through cloud.',
    killed: { reason: 'seen it' },
    relations: [{ type: 'lives_in', target: 'cloud-reef' }],
  }),
  // Structures.
  e({
    id: 'spore-shrine',
    kind: 'structure',
    name: 'Spore Shrine',
    state: 'idea',
    identity: 'A grown altar that hums.',
    fields: { purpose: 'rest point', scale: 'small' },
    relations: [{ type: 'in_biome', target: 'glowmoss-caverns' }],
  }),
  e({
    id: 'sunken-stair',
    kind: 'structure',
    name: 'Sunken Stair',
    state: 'shaped',
    identity: 'Steps leading down from the meadow.',
    fields: { purpose: 'the first way down', scale: 'medium', rewards: 'a map fragment' },
    relations: [{ type: 'in_biome', target: 'meadow-steps' }],
  }),
  // Capabilities.
  e({
    id: 'glide',
    kind: 'capability',
    name: 'Glide',
    state: 'decided',
    identity: 'Fall slowly, steer the fall.',
    why: 'Opens the sky.',
    fields: { verb: 'glide between islands', gates: 'Low Sky' },
    relations: [{ type: 'in_band', target: 'low-sky' }],
  }),
  e({
    id: 'fourth-accessory-slot',
    kind: 'capability',
    name: 'Fourth accessory slot',
    state: 'idea',
    identity: 'Room for one more trinket.',
    fields: { verb: 'wear a fourth accessory' },
  }),
  // Items.
  e({
    id: 'spore-lantern',
    kind: 'item',
    name: 'Spore Lantern',
    state: 'shaped',
    identity: 'Light that breathes.',
    fields: {
      subkind: 'tool',
      change: 'see in the Hollows without torches',
      tradeoff: 'dims when you sprint',
      route: [
        { text: 'gather lumen spores', needs: ['lumen-spore'] },
        { text: 'press at a spore shrine' },
      ],
    },
    relations: [
      { type: 'made_from', target: 'lumen-spore' },
      { type: 'in_band', target: 'hollows' },
    ],
  }),
  e({
    id: 'vent-glass-visor',
    kind: 'item',
    name: 'Vent Glass Visor',
    state: 'idea',
    identity: 'See through heat shimmer.',
    fields: { subkind: 'armor' },
    attributes: { defense: 4 },
    relations: [
      { type: 'made_from', target: 'vent-glass' },
      { type: 'counters', target: 'undercroft' },
      { type: 'requires', target: 'spore-lantern' },
    ],
  }),
  e({
    id: 'cinder-sting',
    kind: 'item',
    name: 'Cinder Sting',
    state: 'exported',
    identity: 'A blade that stays hot.',
    why: 'The first real weapon.',
    fields: {
      subkind: 'weapon',
      change: 'fights become short and decisive',
      tradeoff: 'sets moss alight',
      moment: 'the first wasp nest',
      route: [{ text: 'take a sting from a cinder wasp' }],
    },
    attributes: { damage: 12 },
    relations: [
      { type: 'counters', target: 'cinder-wasp' },
      { type: 'conflicts', target: 'spore-lantern' },
    ],
  }),
  e({
    id: 'cloud-anklet',
    kind: 'item',
    name: 'Cloud Anklet',
    state: 'idea',
    identity: 'One extra step on air.',
    fields: { subkind: 'accessory' },
    relations: [
      { type: 'pairs_with', target: 'glide' },
      { type: 'supersedes', target: 'spore-lantern' },
    ],
  }),
  // Feats.
  e({
    id: 'first-descent',
    kind: 'feat',
    name: 'First Descent',
    state: 'shaped',
    identity: 'Reach the Hollows floor.',
    fields: { deed: 'reach Y −512 alive', reveal: 'the Hollows have weather' },
    relations: [
      { type: 'unlocks', target: 'fourth-accessory-slot' },
      { type: 'in_band', target: 'hollows' },
    ],
  }),
];

/** Adds the missing ends of symmetric relations. */
function withMirrors(entities: Entity[]): Entity[] {
  const byId = new Map(entities.map((x) => [x.id, { ...x, relations: [...x.relations] }]));
  for (const x of entities)
    for (const r of x.relations) {
      if (r.type !== 'conflicts' && r.type !== 'pairs_with') continue;
      const t = byId.get(r.target);
      if (t && !t.relations.some((q) => q.type === r.type && q.target === x.id))
        t.relations.push({ type: r.type, target: x.id });
    }
  return [...byId.values()];
}

export function sampleWorld(): World {
  const w = emptyWorld();
  w.settings = { ...w.settings, name: 'Sample' };
  w.entities = Object.fromEntries(withMirrors(ENTITIES).map((x) => [x.id, x]));
  w.numbers = {
    variables: { k: 100, base_health: 100 },
    formulas: 'taken(raw, def) = raw * k / (k + def)\n',
  };
  w.taste = {
    ...w.taste,
    rules: [{ id: 'no-pure-numbers', text: 'Nothing is just a bigger number.', enabled: true }],
  };
  return w;
}
