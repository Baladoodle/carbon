import { EntitySchema, type Entity, type EntityInput } from '@core/model/entity';
import type { World } from '@core/model/world';
import { sampleWorld, SAMPLE_TIME } from '@core/testing/sample';
import type { CritiqueNote } from '@core/ai/moments';

/**
 * The eval world (docs/SYSTEM.md §8 "Prompt evals"): the sample world plus
 * entities with SEEDED FLAWS the critique must catch, and CLEAN controls it
 * must leave alone. `evals/worlds/flawed/` on disk is generated from this
 * (`UPDATE_FIXTURES=1 npx vitest run src/main/ai/evals`), so you can open it
 * in carbon and see what the evals see.
 */

const e = (input: Omit<EntityInput, 'created' | 'updated'>): Entity =>
  EntitySchema.parse({ created: SAMPLE_TIME, updated: SAMPLE_TIME, ...input });

export type FlawKind = Exclude<CritiqueNote['kind'], 'weak_identity'>;

export interface Seeded {
  entity: Entity;
  /** The critique note kinds that catch this flaw (any one counts). */
  catches: CritiqueNote['kind'][];
  flaw: FlawKind;
}

export const SEEDED: Seeded[] = [
  {
    flaw: 'just_a_number',
    catches: ['just_a_number', 'rule_clash'],
    entity: e({
      id: 'brass-band',
      kind: 'item',
      name: 'Brass Band',
      state: 'shaped',
      identity: 'A ring that gives +10% damage.',
      fields: {
        subkind: 'accessory',
        change: '+10% damage',
        tradeoff: '-5% defense',
      },
      relations: [{ type: 'in_band', target: 'groundline' }],
    }),
  },
  {
    flaw: 'duplicate',
    catches: ['duplicate'],
    entity: e({
      id: 'lumen-spores',
      kind: 'material',
      name: 'Lumen Spores',
      state: 'idea',
      identity: 'Spores that store light.',
      fields: { rarity: 'common' },
      relations: [{ type: 'found_in', target: 'glowmoss-caverns' }],
    }),
  },
  {
    flaw: 'rule_clash',
    catches: ['rule_clash'],
    entity: e({
      id: 'mending-draught',
      kind: 'item',
      name: 'Mending Draught',
      state: 'shaped',
      identity: 'A drink that heals you fully and instantly, any time, at no cost.',
      fields: {
        subkind: 'consumable',
        change: 'restores all health instantly',
        tradeoff: 'none',
      },
      relations: [{ type: 'in_band', target: 'groundline' }],
    }),
  },
  {
    flaw: 'contradicts_relation',
    catches: ['contradicts_relation'],
    entity: e({
      id: 'frost-wisp',
      kind: 'creature',
      name: 'Frost Wisp',
      state: 'idea',
      identity: 'A drifting cold light that freezes what it touches.',
      fields: { temperament: 'curious' },
      // A target that doesn't exist: a dangling relation.
      relations: [{ type: 'lives_in', target: 'frozen-reach' }],
    }),
  },
  {
    flaw: 'contradicts_relation',
    catches: ['contradicts_relation'],
    entity: e({
      id: 'magma-eel',
      kind: 'creature',
      name: 'Magma Eel',
      state: 'idea',
      identity: 'An eel that swims through molten rock and dies in open air.',
      fields: { temperament: 'territorial' },
      // Lives in the sky reef: contradicts its own identity.
      relations: [{ type: 'lives_in', target: 'cloud-reef' }],
    }),
  },
];

/** Entities with no flaw: distinct identity, consistent relations, within the rules. */
export const CLEAN: Entity[] = [
  e({
    id: 'updraft-kite',
    kind: 'item',
    name: 'Updraft Kite',
    state: 'shaped',
    identity:
      'A cloth wing that lets you ride rising heat between islands, if you read the air right.',
    fields: {
      subkind: 'tool',
      change: 'cross gaps between Low Sky islands by riding thermals',
      tradeoff: 'useless in still air; a gust can carry you off course',
    },
    relations: [{ type: 'in_band', target: 'low-sky' }],
  }),
  e({
    id: 'lantern-moth',
    kind: 'creature',
    name: 'Lantern Moth',
    state: 'shaped',
    identity: 'Pale moths that gather around any light in the Hollows and slowly put it out.',
    fields: { temperament: 'skittish', behaviour: 'swarms light sources and smothers them' },
    relations: [{ type: 'lives_in', target: 'glowmoss-caverns' }],
  }),
  e({
    id: 'echo-reading',
    kind: 'capability',
    name: 'Echo Reading',
    state: 'shaped',
    identity: 'Clap, and hear the shape of the dark cavern around you.',
    fields: { verb: 'map unseen caverns by sound', gates: 'routes through unlit Hollows' },
  }),
  e({
    id: 'heat-glass',
    kind: 'material',
    name: 'Heat Glass',
    state: 'shaped',
    identity: 'Glass that holds the warmth of the vent it formed in for days.',
    fields: { rarity: 'uncommon', processing: 'chipped from cooled vent mouths' },
    relations: [{ type: 'found_in', target: 'ash-vents' }],
  }),
];

export const EXTRA_RULES = [
  {
    id: 'no-free-healing',
    text: 'Healing always costs something: time, a resource or a risk.',
    enabled: true,
  },
];

export function evalWorld(): World {
  const w = sampleWorld();
  for (const x of [...SEEDED.map((s) => s.entity), ...CLEAN]) w.entities[x.id] = x;
  w.taste.rules = [...w.taste.rules, ...EXTRA_RULES];
  return w;
}
