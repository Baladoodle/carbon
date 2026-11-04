import type { FieldDef } from '../model/fields';
import { fieldValueSchema } from '../model/fields';
import type { EntityKind } from '../model/kinds';
import { isEditableCommonField } from '../model/schema';
import { getEntity, schemaOf, type World } from '../model/world';
import type { JsonSchema } from './types';

/**
 * JSON Schema helpers for structured outputs. The schemas stay inside the
 * subset structured outputs accept: every object lists all its properties as
 * required and sets `additionalProperties: false`; optional values are
 * `anyOf [T, null]`; no numeric or length constraints (zod checks those after).
 */

export const str = (description?: string): JsonSchema => ({
  type: 'string',
  ...(description ? { description } : {}),
});
export const num = (description?: string): JsonSchema => ({
  type: 'number',
  ...(description ? { description } : {}),
});
export const bool = (): JsonSchema => ({ type: 'boolean' });
export const arr = (items: JsonSchema, description?: string): JsonSchema => ({
  type: 'array',
  items,
  ...(description ? { description } : {}),
});
export const enumOf = (values: readonly string[], description?: string): JsonSchema => ({
  type: 'string',
  enum: [...values],
  ...(description ? { description } : {}),
});
export const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'null' }] });
export const obj = (properties: Record<string, JsonSchema>, description?: string): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...(description ? { description } : {}),
});

/** Ref fields list their possible targets as an enum when there are this few. */
export const REF_ENUM_LIMIT = 200;

const range = (): JsonSchema => obj({ min: num(), max: num() });

/** The JSON schema of one field's value. */
export function fieldJsonSchema(world: World, def: FieldDef): JsonSchema {
  switch (def.type) {
    case 'text':
    case 'longtext':
      return str();
    case 'number':
      return num();
    case 'range':
      return range();
    case 'enum':
      return def.options && def.options.length > 0 ? enumOf(def.options) : str();
    case 'list':
      return arr(str());
    case 'height':
      return { anyOf: [num(), enumOf(['-inf', '+inf'])] };
    case 'ref': {
      const ids = Object.values(world.entities)
        .filter((e) => !def.refKinds || def.refKinds.includes(e.kind))
        .map((e) => e.id)
        .sort();
      return ids.length > 0 && ids.length <= REF_ENUM_LIMIT
        ? enumOf(ids, 'an entity id')
        : str('an entity id');
    }
    case 'climate':
      return obj({ temperature: range(), moisture: range() }, 'each min/max within 0..1');
    case 'steps':
      return arr(obj({ text: str(), needs: arr(str('an entity id')) }));
    case 'boolean':
      return bool();
  }
}

/** A field a moment may write: a common text field or a kind field. */
export interface WritableField {
  key: string;
  label: string;
  type: FieldDef['type'] | 'common';
  help?: string;
  def?: FieldDef;
}

const COMMON_HELP: Record<string, string> = {
  name: 'The entity’s name, in the world’s own voice',
  identity: 'A one-line fantasy: what it is and why it matters, in one sentence',
  description: 'A short paragraph of markdown',
  why: 'Why this belongs in the design (the designer’s reason)',
  tags: 'A few lowercase tags',
};

/** The field `key` on `kind`, if the AI may write it. */
export function writableField(world: World, kind: EntityKind, key: string): WritableField | null {
  if (isEditableCommonField(key))
    return { key, label: key, type: 'common', help: COMMON_HELP[key] ?? '' };
  const def = schemaOf(world).kinds[kind].fields.find((f) => f.key === key);
  if (!def || def.ai === false) return null;
  return { key, label: def.label, type: def.type, ...(def.help ? { help: def.help } : {}), def };
}

export function writableJsonSchema(world: World, f: WritableField): JsonSchema {
  if (f.def) return fieldJsonSchema(world, f.def);
  return f.key === 'tags' ? arr(str()) : str();
}

/**
 * Validates and normalises a proposed value for a field: its zod schema, and
 * every id it mentions must exist. Returns `undefined` when invalid.
 */
export function validFieldValue(world: World, f: WritableField, value: unknown): unknown {
  if (!f.def) {
    if (f.key === 'tags')
      return Array.isArray(value) && value.every((t) => typeof t === 'string')
        ? value.map((t) => t.trim()).filter(Boolean)
        : undefined;
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    return value.trim();
  }
  let v = value;
  if (f.def.type === 'steps' && Array.isArray(v))
    v = v.map((s: unknown) => {
      if (
        s &&
        typeof s === 'object' &&
        'needs' in s &&
        Array.isArray(s.needs) &&
        s.needs.length === 0
      ) {
        const { needs: _needs, ...rest } = s as Record<string, unknown>;
        return rest;
      }
      return s;
    });
  if (typeof v === 'string' && (f.def.type === 'text' || f.def.type === 'longtext')) {
    v = v.trim();
    if (v === '') return undefined;
  }
  const parsed = fieldValueSchema(f.def).safeParse(v);
  if (!parsed.success) return undefined;
  if (f.def.type === 'ref') {
    const target = getEntity(world, parsed.data as string);
    if (!target || (f.def.refKinds && !f.def.refKinds.includes(target.kind))) return undefined;
  }
  if (f.def.type === 'steps')
    for (const s of parsed.data as { needs?: string[] }[])
      for (const n of s.needs ?? []) if (!getEntity(world, n)) return undefined;
  return parsed.data;
}

/** Name comparison that ignores case, spacing and punctuation. */
export const normName = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Whether `name` duplicates the name of an existing entity (other than `except`). */
export function duplicatesName(world: World, name: string, except?: string): boolean {
  const n = normName(name);
  if (n === '') return false;
  return Object.values(world.entities).some((e) => e.id !== except && normName(e.name) === n);
}
