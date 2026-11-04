import { z } from 'zod';
import { EntityKindSchema } from '../model/kinds';
import { AttributeDefSchema, SchemaFileSchema, type SchemaFile } from '../model/schema';
import {
  KillReasonSchema,
  PatternSchema,
  SpreadRecordSchema,
  TasteRuleSchema,
} from '../model/world';
import { err, ok } from '../util/result';
import { defineCommand } from './define';
import type { Patch } from './patch';

type KindOverride = NonNullable<SchemaFile['kinds'][keyof SchemaFile['kinds']]>;

/** Replaces one kind's override in `schema.json` (`null` removes it). */
export const setKindOverride = defineCommand({
  payload: z.object({
    kind: EntityKindSchema,
    override: SchemaFileSchema.shape.kinds.unwrap().valueType.nullable(),
  }),
  label: (p) => `Change the ${p.kind} schema`,
  plan(world, p) {
    const kinds = { ...world.schema.kinds };
    if (p.override === null) delete kinds[p.kind];
    else kinds[p.kind] = p.override;
    return ok([{ op: 'set', path: ['schema', 'kinds'], value: kinds }]);
  },
});

/** Adds or replaces an attribute definition on a kind (Numbers view). */
export const setAttributeDef = defineCommand({
  payload: z.object({ kind: EntityKindSchema, def: AttributeDefSchema }),
  label: (p) => `Define ${p.kind}.${p.def.key}`,
  plan(world, p) {
    const current: KindOverride = world.schema.kinds[p.kind] ?? {};
    const attributes = (current.attributes ?? []).filter((a) => a.key !== p.def.key);
    attributes.push(p.def);
    return ok([
      {
        op: 'set',
        path: ['schema', 'kinds'],
        value: { ...world.schema.kinds, [p.kind]: { ...current, attributes } },
      },
    ]);
  },
});

/** Adds, replaces or removes (`null`) a relation type in `schema.json`. */
export const setRelationType = defineCommand({
  payload: z.object({
    type: z.string().regex(/^[a-z][a-z0-9_]*$/),
    def: SchemaFileSchema.shape.relations.unwrap().element.nullable(),
  }),
  label: (p) => `Change relation type ${p.type}`,
  plan(world, p) {
    if (p.def && p.def.type !== p.type) return err('schema.mismatch', 'def.type must equal type');
    const rest = world.schema.relations.filter((r) => r.type !== p.type);
    return ok([
      { op: 'set', path: ['schema', 'relations'], value: p.def ? [...rest, p.def] : rest },
    ]);
  },
});

export const setVariable = defineCommand({
  payload: z.object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    /** `null` removes the variable. */
    value: z.union([z.number().refine(Number.isFinite), z.string(), z.boolean()]).nullable(),
  }),
  label: (p) => `Set ${p.name}`,
  plan(world, p) {
    const variables = { ...world.numbers.variables };
    if (p.value === null) delete variables[p.name];
    else variables[p.name] = p.value;
    return ok([{ op: 'set', path: ['numbers', 'variables'], value: variables }]);
  },
});

export const setFormulas = defineCommand({
  payload: z.object({ source: z.string() }),
  label: () => 'Edit formulas',
  plan: (_world, p) => ok([{ op: 'set', path: ['numbers', 'formulas'], value: p.source }]),
});

/** Sets one top-level key of `carbon.json` (except `format`, which migrations own). */
export const setSetting = defineCommand({
  payload: z.object({
    key: z
      .string()
      .min(1)
      .refine((k) => k !== 'format', 'format is not a setting'),
    value: z.unknown(),
  }),
  label: (p) => `Change setting ${p.key}`,
  plan: (_world, p) =>
    ok([
      p.value === undefined
        ? { op: 'remove', path: ['settings', p.key] }
        : { op: 'set', path: ['settings', p.key], value: p.value },
    ]),
});

/** Replaces whole taste lists (W5 may add finer commands). */
export const setTaste = defineCommand({
  payload: z.object({
    rules: z.array(TasteRuleSchema).optional(),
    reasons: z.array(KillReasonSchema).optional(),
    patterns: z.array(PatternSchema).optional(),
  }),
  label: () => 'Change taste',
  plan(_world, p) {
    const patch: Patch = [];
    if (p.rules) patch.push({ op: 'set', path: ['taste', 'rules'], value: p.rules });
    if (p.reasons) patch.push({ op: 'set', path: ['taste', 'reasons'], value: p.reasons });
    if (p.patterns) patch.push({ op: 'set', path: ['taste', 'patterns'], value: p.patterns });
    return ok(patch);
  },
});

/** Writes (creates or replaces) a spread record. */
export const putSpread = defineCommand({
  payload: z.object({ record: SpreadRecordSchema }),
  label: () => 'Save spread',
  plan: (_world, p) => ok([{ op: 'set', path: ['spreads', p.record.id], value: p.record }]),
});

export const removeSpread = defineCommand({
  payload: z.object({ id: z.string() }),
  label: () => 'Remove spread',
  plan: (world, p) =>
    Object.prototype.hasOwnProperty.call(world.spreads, p.id)
      ? ok([{ op: 'remove', path: ['spreads', p.id] }])
      : err('spread.not_found', `no spread "${p.id}"`),
});

export const worldCommands = {
  'schema.setKind': setKindOverride,
  'schema.setAttributeDef': setAttributeDef,
  'schema.setRelationType': setRelationType,
  'numbers.setVariable': setVariable,
  'numbers.setFormulas': setFormulas,
  'settings.set': setSetting,
  'taste.set': setTaste,
  'spread.put': putSpread,
  'spread.remove': removeSpread,
} as const;
