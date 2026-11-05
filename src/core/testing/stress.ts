import { EntitySchema, type Entity, type EntityInput, type Relation } from '../model/entity';
import { ITEM_SUBKINDS, type EntityKind, type EntityState } from '../model/kinds';
import { emptyWorld, type World } from '../model/world';
import { seededRandom } from '../util/hash';
import { fromU } from '../column/scale';

/**
 * A generated stress world for the Column's performance budget (docs/SYSTEM.md
 * §9: 2,000 entities at ≥ 50 fps while panning). Deterministic: the same
 * `count` and `seed` give the same world. Bands tile the whole axis, biomes
 * sit in bands, and everything else is placed explicitly (in_band / in_biome),
 * inferred (found_in / lives_in) or not at all (the Inbox), in every state.
 * It is test data, not design content.
 */
const TIME = '2026-11-01T12:00:00.000Z';
const KINDS: EntityKind[] = ['material', 'creature', 'structure', 'capability', 'item', 'feat'];
const STATES: EntityState[] = [
  'idea',
  'idea',
  'shaped',
  'shaped',
  'decided',
  'exported',
  'graveyard',
];
const WORDS = [
  'ash',
  'brine',
  'cinder',
  'dusk',
  'ember',
  'fern',
  'gloam',
  'husk',
  'iron',
  'jade',
  'kelp',
  'lumen',
  'moss',
  'nacre',
  'onyx',
  'pale',
  'quill',
  'rust',
  'salt',
  'thorn',
  'umber',
  'vesper',
  'wisp',
  'yew',
  'zinc',
];

export function stressWorld(count = 2000, seed = 'column-stress'): World {
  const rand = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const name = (i: number): string => `${title(pick(WORDS))} ${pick(WORDS)} ${i}`;
  const entities: Entity[] = [];
  const add = (x: Omit<EntityInput, 'created' | 'updated'>): void => {
    entities.push(EntitySchema.parse({ created: TIME, updated: TIME, ...x }));
  };

  // 40 bands tiling −∞ … +∞ with edges evenly spaced on the scale.
  const bandCount = 40;
  const edges: number[] = [];
  for (let i = 1; i < bandCount; i++) {
    const u = -4 + (8 * i) / bandCount;
    edges.push(Math.round(fromU(u)));
  }
  const bands: string[] = [];
  for (let i = 0; i < bandCount; i++) {
    const id = `band-${i}`;
    bands.push(id);
    add({
      id,
      kind: 'band',
      name: `Band ${i}`,
      state: pick(STATES.filter((s) => s !== 'graveyard')),
      identity: `Stress band ${i}.`,
      fields: {
        y_bottom: i === 0 ? '-inf' : edges[i - 1],
        y_top: i === bandCount - 1 ? '+inf' : edges[i],
      },
    });
  }
  // Two biomes per band.
  const biomes: string[] = [];
  for (const band of bands)
    for (let k = 0; k < 2; k++) {
      const id = `${band}-biome-${k}`;
      biomes.push(id);
      add({
        id,
        kind: 'biome',
        name: `${title(pick(WORDS))} reach ${band.slice(5)}.${k}`,
        state: pick(STATES.filter((x) => x !== 'graveyard')),
        identity: 'A stress biome.',
        fields: { band },
      });
    }
  // The rest: placed explicitly, inferred, or not at all.
  for (let i = entities.length; i < count; i++) {
    const kind = pick(KINDS);
    const r = rand();
    const relations: Relation[] = [];
    if (r < 0.45) relations.push({ type: 'in_band', target: pick(bands) });
    else if (r < 0.75 && kind !== 'feat' && kind !== 'capability')
      relations.push({ type: 'in_biome', target: pick(biomes) });
    else if (r < 0.95 && kind === 'material')
      relations.push({ type: 'found_in', target: pick(biomes) });
    else if (r < 0.95 && kind === 'creature')
      relations.push({ type: 'lives_in', target: pick(biomes) });
    else if (r < 0.95) relations.push({ type: 'in_band', target: pick(bands) });
    const state = pick(STATES);
    add({
      id: `e-${i}`,
      kind,
      name: name(i),
      state,
      identity: `Stress ${kind} ${i}.`,
      fields: kind === 'item' ? { subkind: pick(ITEM_SUBKINDS) } : {},
      relations,
      ...(state === 'graveyard' ? { killed: { reason: 'seen it' } } : {}),
    });
  }
  const w = emptyWorld();
  w.settings = { ...w.settings, name: 'Column stress' };
  w.entities = Object.fromEntries(entities.map((e) => [e.id, e]));
  return w;
}
