import { z } from 'zod';
import { EntityIdSchema, TimestampSchema } from './ids';
import { EntityKindSchema, EntityStateSchema } from './kinds';

/** A typed, directed relation, stored on its source entity. */
export const RelationSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]*$/),
  target: EntityIdSchema,
  /** Why the relation holds (the Ground move fills this). */
  note: z.string().optional(),
});
export type Relation = z.infer<typeof RelationSchema>;

/** Who wrote an entity, and from where. */
export const OriginSchema = z.object({
  by: z.enum(['user', 'ai']),
  /** The spread it was kept from, if any. */
  spread: z.string().optional(),
  /** The AI moment that produced it (e.g. `spread`, `fill_entity`). */
  moment: z.string().optional(),
});
export type Origin = z.infer<typeof OriginSchema>;

/** Why an entity is in the graveyard (docs/EXPERIENCE.md §4 kill reasons). */
export const KilledSchema = z.object({
  reason: z.string(),
  note: z.string().optional(),
});
export type Killed = z.infer<typeof KilledSchema>;

export const AttributesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]*$/),
  z.number().refine(Number.isFinite, 'attributes are finite numbers'),
);

/**
 * The common shape of every entity (docs/SYSTEM.md §3). Kind-specific values live
 * in `fields`, keyed by the kind schema; `entityProblems` checks them against it.
 * `description` is the markdown body of the entity's file.
 */
export const EntitySchema = z.object({
  id: EntityIdSchema,
  kind: EntityKindSchema,
  name: z.string().min(1, 'an entity needs a name'),
  identity: z.string().default(''),
  description: z.string().default(''),
  state: EntityStateSchema.default('idea'),
  why: z.string().default(''),
  tags: z.array(z.string()).default([]),
  fields: z.record(z.string(), z.unknown()).default({}),
  attributes: AttributesSchema.default({}),
  relations: z.array(RelationSchema).default([]),
  origin: OriginSchema.default({ by: 'user' }),
  /** Keys (common or kind fields) whose current value the AI wrote and you haven't edited. */
  ai_fields: z.array(z.string()).default([]),
  killed: KilledSchema.optional(),
  created: TimestampSchema,
  updated: TimestampSchema,
});
/** A fully defaulted entity, as held in the world. */
export type Entity = z.infer<typeof EntitySchema>;
/** What a file or a command may provide (defaults filled in on parse). */
export type EntityInput = z.input<typeof EntitySchema>;
