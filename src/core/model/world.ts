import { z } from 'zod';
import { DEFAULT_SCHEMA } from './defaults';
import { EntitySchema, type Entity } from './entity';
import type { EntityId } from './ids';
import type { EntityKind } from './kinds';
import { resolveSchema, SchemaFileSchema, type WorldSchema } from './schema';

/** The on-disk format version (`carbon.json` → `format`). W6 adds migrations. */
export const WORLD_FORMAT = 1;

/** `carbon.json`. Unknown keys are kept, so packages can add settings without a migration. */
export const SettingsSchema = z.looseObject({
  format: z.number().int().positive().default(WORLD_FORMAT),
  name: z.string().default('Infinite'),
  ai: z
    .looseObject({
      /** Spend limits in US dollars; the AI pauses when one is reached. */
      budget: z
        .looseObject({
          sessionUsd: z.number().min(0).default(2),
          monthUsd: z.number().min(0).default(20),
        })
        .default({ sessionUsd: 2, monthUsd: 20 }),
    })
    .default({ budget: { sessionUsd: 2, monthUsd: 20 } }),
  snapshot: z
    .looseObject({ idleMinutes: z.number().min(1).default(10) })
    .default({ idleMinutes: 10 }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** `numbers/variables.json` and `numbers/formulas.carbon` (W3 owns their meaning). */
export const NumbersSchema = z.object({
  variables: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  formulas: z.string().default(''),
});
export type Numbers = z.infer<typeof NumbersSchema>;

/** `taste/*.json` (W5 owns their meaning; loose so W5 can extend them). */
export const TasteRuleSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  enabled: z.boolean().default(true),
});
export const KillReasonSchema = z.looseObject({
  /** The key pressed after `x`: "1".."7", or "0" for other. */
  key: z.string(),
  label: z.string(),
  count: z.number().int().min(0).default(0),
});
export const PatternSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  status: z.enum(['proposed', 'promoted', 'dismissed']).default('proposed'),
  examples: z.array(z.string()).default([]),
});
export const TasteSchema = z.object({
  rules: z.array(TasteRuleSchema).default([]),
  reasons: z.array(KillReasonSchema).default([]),
  patterns: z.array(PatternSchema).default([]),
});
export type Taste = z.infer<typeof TasteSchema>;

export const DEFAULT_KILL_REASONS: Taste['reasons'] = [
  { key: '1', label: 'just a number', count: 0 },
  { key: '2', label: 'seen it', count: 0 },
  { key: '3', label: 'off-tone', count: 0 },
  { key: '4', label: 'wrong place', count: 0 },
  { key: '5', label: 'fiddly', count: 0 },
  { key: '6', label: 'redundant', count: 0 },
  { key: '7', label: 'breaks a rule', count: 0 },
  { key: '0', label: 'other', count: 0 },
];

/** `spreads/<id>.json`: one per spread (W5 owns the shape beyond these keys). */
export const SpreadRecordSchema = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  created: z.string(),
});
export type SpreadRecord = z.infer<typeof SpreadRecordSchema>;

/**
 * The whole world as one JSON document: the single source of truth in the main
 * process, mirrored in the renderer through a snapshot and then patches. Every
 * top-level key maps to files in the world directory (src/main/store).
 */
export const WorldSchemaZ = z.object({
  settings: SettingsSchema,
  /** `schema.json`: the overrides. Use `schemaOf(world)` for the effective schema. */
  schema: SchemaFileSchema,
  entities: z.record(z.string(), EntitySchema),
  numbers: NumbersSchema,
  taste: TasteSchema,
  spreads: z.record(z.string(), SpreadRecordSchema),
});
export type World = z.infer<typeof WorldSchemaZ>;

export function emptyWorld(): World {
  return {
    settings: SettingsSchema.parse({}),
    schema: { kinds: {}, relations: [] },
    entities: {},
    numbers: { variables: {}, formulas: '' },
    taste: { rules: [], reasons: DEFAULT_KILL_REASONS.map((r) => ({ ...r })), patterns: [] },
    spreads: {},
  };
}

const schemaCache = new WeakMap<object, WorldSchema>();

/** The effective schema of a world (defaults + `schema.json`), memoised per schema object. */
export function schemaOf(world: Pick<World, 'schema'>): WorldSchema {
  let s = schemaCache.get(world.schema);
  if (!s) {
    s = resolveSchema(DEFAULT_SCHEMA, world.schema);
    schemaCache.set(world.schema, s);
  }
  return s;
}

export const getEntity = (world: World, id: EntityId): Entity | undefined =>
  Object.prototype.hasOwnProperty.call(world.entities, id) ? world.entities[id] : undefined;

export const entitiesOfKind = (world: World, kind: EntityKind): Entity[] =>
  Object.values(world.entities)
    .filter((e) => e.kind === kind)
    .sort((a, b) => a.id.localeCompare(b.id));
