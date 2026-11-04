import { z } from 'zod';
import { FieldDefSchema } from './fields';
import { EntityKindSchema, ENTITY_KINDS, LaneSchema, type EntityKind } from './kinds';

/** A named number on entities of a kind, e.g. armor's `defense` (edited in Numbers). */
export const AttributeDefSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().optional(),
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  default: z.number().optional(),
  /** Only applies when these kind fields equal these values, e.g. `{ subkind: "armor" }`. */
  when: z.record(z.string(), z.string()).optional(),
  help: z.string().optional(),
});
export type AttributeDef = z.infer<typeof AttributeDefSchema>;

/**
 * Fields required to *be in* a state. Requirements accumulate: `decided` also
 * needs everything `shaped` needs. Keys may be common fields (`identity`, `why`,
 * `description`) or kind fields.
 */
export const RequirementsSchema = z.object({
  idea: z.array(z.string()).default([]),
  shaped: z.array(z.string()).default([]),
  decided: z.array(z.string()).default([]),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

export const KindDefSchema = z.object({
  kind: EntityKindSchema,
  label: z.string(),
  plural: z.string(),
  lane: LaneSchema.nullable(),
  /** One line describing the kind, for the Bench and AI prompts. */
  help: z.string(),
  fields: z.array(FieldDefSchema),
  attributes: z.array(AttributeDefSchema),
  required: RequirementsSchema,
});
export type KindDef = z.infer<typeof KindDefSchema>;

/** `"*"` means any entity kind. */
export const KindSetSchema = z.union([z.literal('*'), z.array(EntityKindSchema).min(1)]);
export type KindSet = z.infer<typeof KindSetSchema>;

export const RelationTypeDefSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string(),
  /** How it reads from the target's side, e.g. "made into" for made_from. */
  inverseLabel: z.string(),
  from: KindSetSchema,
  to: KindSetSchema,
  /** Stored on both ends; adding or removing one end does both. */
  symmetric: z.boolean().default(false),
  /** The graph of this relation type must have no cycles. */
  acyclic: z.boolean().default(false),
  help: z.string().optional(),
});
export type RelationTypeDef = z.infer<typeof RelationTypeDefSchema>;

/** The effective schema: built-in defaults merged with the world's `schema.json`. */
export interface WorldSchema {
  kinds: Record<EntityKind, KindDef>;
  relations: Record<string, RelationTypeDef>;
}

/**
 * `schema.json`: overrides on top of the defaults. Fields, attributes and
 * relation types merge by key (an override replaces the default with that key,
 * new keys are appended); `required`, if given, replaces that state's list.
 */
export const SchemaFileSchema = z.object({
  kinds: z
    .partialRecord(
      EntityKindSchema,
      z.object({
        label: z.string().optional(),
        plural: z.string().optional(),
        help: z.string().optional(),
        fields: z.array(FieldDefSchema).optional(),
        attributes: z.array(AttributeDefSchema).optional(),
        required: z
          .object({
            idea: z.array(z.string()).optional(),
            shaped: z.array(z.string()).optional(),
            decided: z.array(z.string()).optional(),
          })
          .optional(),
        /** Field keys to remove from the defaults. */
        removeFields: z.array(z.string()).optional(),
      }),
    )
    .default({}),
  relations: z.array(RelationTypeDefSchema).default([]),
});
export type SchemaFile = z.infer<typeof SchemaFileSchema>;

export const EMPTY_SCHEMA_FILE: SchemaFile = { kinds: {}, relations: [] };

/** Common entity fields; a kind field may not reuse these keys. */
export const COMMON_FIELDS = [
  'id',
  'kind',
  'name',
  'identity',
  'description',
  'state',
  'why',
  'tags',
  'attributes',
  'relations',
  'origin',
  'ai_fields',
  'created',
  'updated',
  'fields',
  'killed',
] as const;

/** Common fields a user (or the AI) edits as text, like kind fields. */
export const EDITABLE_COMMON_FIELDS = ['name', 'identity', 'description', 'why', 'tags'] as const;
export type EditableCommonField = (typeof EDITABLE_COMMON_FIELDS)[number];

export const isEditableCommonField = (key: string): key is EditableCommonField =>
  (EDITABLE_COMMON_FIELDS as readonly string[]).includes(key);

function mergeByKey<T, K extends keyof T>(base: T[], over: T[] | undefined, key: K): T[] {
  if (!over) return base;
  const out = base.map((b) => over.find((o) => o[key] === b[key]) ?? b);
  for (const o of over) if (!base.some((b) => b[key] === o[key])) out.push(o);
  return out;
}

/** Merges a `schema.json` onto the defaults. Pure; never mutates its inputs. */
export function resolveSchema(defaults: WorldSchema, file: SchemaFile): WorldSchema {
  const kinds = {} as Record<EntityKind, KindDef>;
  for (const kind of ENTITY_KINDS) {
    const base = defaults.kinds[kind];
    const o = file.kinds[kind];
    if (!o) {
      kinds[kind] = base;
      continue;
    }
    const removed = new Set(o.removeFields ?? []);
    kinds[kind] = {
      ...base,
      label: o.label ?? base.label,
      plural: o.plural ?? base.plural,
      help: o.help ?? base.help,
      fields: mergeByKey(base.fields, o.fields, 'key').filter((f) => !removed.has(f.key)),
      attributes: mergeByKey(base.attributes, o.attributes, 'key'),
      required: {
        idea: o.required?.idea ?? base.required.idea,
        shaped: o.required?.shaped ?? base.required.shaped,
        decided: o.required?.decided ?? base.required.decided,
      },
    };
  }
  const relations: Record<string, RelationTypeDef> = { ...defaults.relations };
  for (const r of file.relations) relations[r.type] = r;
  return { kinds, relations };
}

/** Problems that make a resolved schema unusable (e.g. a field shadowing a common field). */
export function schemaProblems(schema: WorldSchema): string[] {
  const problems: string[] = [];
  for (const kind of ENTITY_KINDS) {
    const def = schema.kinds[kind];
    const seen = new Set<string>();
    for (const f of def.fields) {
      if ((COMMON_FIELDS as readonly string[]).includes(f.key))
        problems.push(`${kind}.${f.key} shadows a common field`);
      if (seen.has(f.key)) problems.push(`${kind}.${f.key} is defined twice`);
      seen.add(f.key);
      if (f.type === 'enum' && (f.options ?? []).length === 0)
        problems.push(`${kind}.${f.key} is an enum without options`);
    }
  }
  return problems;
}
