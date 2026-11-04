import type { EntityKind } from '../model/kinds';
import { ENTITY_KINDS } from '../model/kinds';
import type { FieldDef } from '../model/fields';
import type { AttributeDef, WorldSchema } from '../model/schema';
import { BOOL, entityOf, listOf, NUMBER, STRING, type Type } from './types';

/**
 * The properties an entity exposes to formulas (`c.health`, `.defense`,
 * `band == b`), derived from the effective kind schema, so a new attribute or
 * field is usable at once.
 *
 *   common:     id, name, kind, state, identity (strings); tags (list of string)
 *   placement:  band (a band), tier (a number)
 *   fields:     text and enum → string; number and height → number; boolean → bool;
 *               ref → entity; list → list of string; a range `danger` → danger_min, danger_max
 *   attributes: numbers (the kind's attribute definitions)
 *
 * Fields that have no value form (climate, steps) are listed as unusable, so
 * using one gives a precise error rather than "unknown".
 */
export type PropSource =
  | { from: 'common'; key: 'id' | 'name' | 'kind' | 'state' | 'identity' | 'tags' }
  | { from: 'placement'; key: 'band' | 'tier' }
  | { from: 'field'; key: string; def: FieldDef; part?: 'min' | 'max' }
  | { from: 'attribute'; key: string; def: AttributeDef };

export interface Prop {
  name: string;
  type: Type;
  source: PropSource;
}

export interface Unusable {
  name: string;
  why: string;
  hint?: string;
}

export interface KindProps {
  props: Map<string, Prop>;
  unusable: Map<string, Unusable>;
}

function fieldProps(f: FieldDef, add: (p: Prop) => void, bad: (u: Unusable) => void): void {
  const src = (part?: 'min' | 'max'): PropSource =>
    part ? { from: 'field', key: f.key, def: f, part } : { from: 'field', key: f.key, def: f };
  switch (f.type) {
    case 'text':
    case 'longtext':
    case 'enum':
      add({ name: f.key, type: STRING, source: src() });
      return;
    case 'number':
    case 'height':
      add({ name: f.key, type: NUMBER, source: src() });
      return;
    case 'boolean':
      add({ name: f.key, type: BOOL, source: src() });
      return;
    case 'ref': {
      const kinds = f.refKinds ?? [];
      add({
        name: f.key,
        type: entityOf(kinds.length === 1 ? (kinds[0] ?? null) : null),
        source: src(),
      });
      return;
    }
    case 'list':
      add({ name: f.key, type: listOf(STRING), source: src() });
      return;
    case 'range':
      add({ name: `${f.key}_min`, type: NUMBER, source: src('min') });
      add({ name: `${f.key}_max`, type: NUMBER, source: src('max') });
      bad({
        name: f.key,
        why: `${f.key} is a range`,
        hint: `Use ${f.key}_min or ${f.key}_max`,
      });
      return;
    case 'climate':
      bad({ name: f.key, why: `${f.key} is a climate rectangle, not a value` });
      return;
    case 'steps':
      bad({ name: f.key, why: `${f.key} is a list of steps, not a value` });
      return;
  }
}

const cache = new WeakMap<WorldSchema, Map<EntityKind, KindProps>>();

/** The properties of one kind (memoised per schema object). */
export function propsOf(schema: WorldSchema, kind: EntityKind): KindProps {
  let byKind = cache.get(schema);
  if (!byKind) {
    byKind = new Map();
    cache.set(schema, byKind);
  }
  const hit = byKind.get(kind);
  if (hit) return hit;
  const props = new Map<string, Prop>();
  const unusable = new Map<string, Unusable>();
  const add = (p: Prop): void => {
    if (!props.has(p.name)) props.set(p.name, p);
  };
  const bad = (u: Unusable): void => {
    if (!props.has(u.name) && !unusable.has(u.name)) unusable.set(u.name, u);
  };
  for (const key of ['id', 'name', 'kind', 'state', 'identity'] as const)
    add({ name: key, type: STRING, source: { from: 'common', key } });
  add({ name: 'tags', type: listOf(STRING), source: { from: 'common', key: 'tags' } });
  const def = schema.kinds[kind];
  for (const f of def.fields) fieldProps(f, add, bad);
  for (const a of def.attributes)
    add({ name: a.key, type: NUMBER, source: { from: 'attribute', key: a.key, def: a } });
  add({ name: 'band', type: entityOf('band'), source: { from: 'placement', key: 'band' } });
  add({ name: 'tier', type: NUMBER, source: { from: 'placement', key: 'tier' } });
  const out = { props, unusable };
  byKind.set(kind, out);
  return out;
}

/** Every kind that has a property with this name. */
export function kindsWithProp(schema: WorldSchema, name: string): EntityKind[] {
  return ENTITY_KINDS.filter((k) => propsOf(schema, k).props.has(name));
}

/** Collection names: `bands`, `items`, … and `entities` (all kinds). */
export const COLLECTIONS: Record<string, EntityKind | null> = {
  bands: 'band',
  biomes: 'biome',
  materials: 'material',
  creatures: 'creature',
  structures: 'structure',
  capabilities: 'capability',
  items: 'item',
  feats: 'feat',
  entities: null,
};
