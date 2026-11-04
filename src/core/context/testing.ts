import { EntitySchema, type Entity } from '../model/entity';
import { ENTITY_KINDS, ENTITY_STATES, type EntityKind } from '../model/kinds';
import { emptyWorld, type World } from '../model/world';
import { seededRandom } from '../util/hash';

/**
 * A synthetic world of any size, from a seed: bands stacked on Y, biomes in
 * them, and entities of every kind related to them and to each other. For
 * packer property tests and performance checks (never shipped content).
 */
export function syntheticWorld(seed: string, count: number, textScale = 1): World {
  const rand = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const words = [
    'ember',
    'glass',
    'drift',
    'moss',
    'salt',
    'thorn',
    'vesper',
    'ash',
    'tide',
    'lumen',
  ];
  const text = (n: number): string =>
    Array.from({ length: Math.max(1, Math.round(n * textScale)) }, () => pick(words)).join(' ');
  const w = emptyWorld();
  const bands: string[] = [];
  const biomes: string[] = [];
  const all: Entity[] = [];
  const stamp = (i: number): string =>
    new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 300) * 86_400_000 + i).toISOString();
  const nBands = Math.max(1, Math.min(12, Math.ceil(count / 40)));
  for (let i = 0; i < count; i++) {
    const kind: EntityKind =
      i < nBands
        ? 'band'
        : i < nBands * 3
          ? 'biome'
          : pick(ENTITY_KINDS.filter((k) => k !== 'band'));
    const id = `${kind}-${i}`;
    const fields: Record<string, unknown> = {};
    const relations: { type: string; target: string }[] = [];
    if (kind === 'band') {
      fields.y_bottom = i === 0 ? '-inf' : (i - 1) * 100;
      fields.y_top = i === nBands - 1 ? '+inf' : i * 100;
      fields.character = text(4);
      bands.push(id);
    } else if (kind === 'biome') {
      fields.band = pick(bands);
      biomes.push(id);
    } else if (rand() < 0.7) {
      relations.push(
        rand() < 0.5 || biomes.length === 0
          ? { type: 'in_band', target: pick(bands) }
          : { type: 'in_biome', target: pick(biomes) },
      );
    }
    if (kind === 'item' && rand() < 0.5 && all.length > 0) {
      const mat = all.find((e) => e.kind === 'material');
      if (mat) relations.push({ type: 'made_from', target: mat.id });
    }
    const t = stamp(i);
    all.push(
      EntitySchema.parse({
        id,
        kind,
        name: `${text(1)} ${text(1)} ${i}`,
        identity: text(8),
        description: text(rand() < 0.2 ? 200 : 20),
        state: pick(ENTITY_STATES.filter((s) => s !== 'exported')),
        fields,
        attributes: rand() < 0.3 ? { power: Math.round(rand() * 100) } : {},
        relations,
        created: t,
        updated: t,
      }),
    );
  }
  for (const e of all) w.entities[e.id] = e;
  w.taste.rules = [
    { id: 'r1', text: text(10), enabled: true },
    { id: 'r2', text: text(10), enabled: rand() < 0.5 },
  ];
  return w;
}
