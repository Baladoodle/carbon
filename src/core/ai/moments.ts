import { z } from 'zod';
import { RelationSchema } from '../model/entity';
import { EntityIdSchema } from '../model/ids';
import { EntityKindSchema, LaneSchema } from '../model/kinds';
import { ClimateSchema } from '../model/fields';

/**
 * The AI moments (docs/EXPERIENCE.md §5) and, for each, the request a UI sends
 * and the result it gets back. Requests carry only what the UI knows (ids,
 * fields, the spot); the gateway builds the prompt from the world itself.
 * Results are validated with these schemas before anyone sees them.
 */

export const MOMENTS = [
  'suggest_one',
  'suggest_three',
  'fill_entity',
  'critique',
  'spread',
  'patterns',
  'spec_draft',
] as const;
export const MomentSchema = z.enum(MOMENTS);
export type Moment = z.infer<typeof MomentSchema>;

/** A proposed value for a common or kind field; checked against the field's schema by the gateway. */
export const FieldValueSchema = z.unknown();

// ── suggest one / three ─────────────────────────────────────────────────────

export const SuggestRequestSchema = z.object({
  entityId: EntityIdSchema,
  /** A common text field (`name`, `identity`, `description`, `why`) or a kind field key. */
  field: z.string(),
  /** Values already shown, so `tab` again gives another. */
  avoid: z.array(z.unknown()).default([]),
});
export const SuggestionSchema = z.object({
  value: FieldValueSchema,
  /** A short reason, shown dimmed. */
  note: z.string().optional(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;
export const SuggestOneResultSchema = z.object({ suggestion: SuggestionSchema });
export const SuggestThreeResultSchema = z.object({
  suggestions: z.array(SuggestionSchema).length(3),
});

// ── fill entity ─────────────────────────────────────────────────────────────

export const FillRequestSchema = z.object({ entityId: EntityIdSchema });
export const FillResultSchema = z.object({
  proposals: z.array(
    z.object({ field: z.string(), value: FieldValueSchema, note: z.string().optional() }),
  ),
});

// ── critique ────────────────────────────────────────────────────────────────

export const CRITIQUE_KINDS = [
  'just_a_number',
  'rule_clash',
  'duplicate',
  'contradicts_relation',
  'weak_identity',
] as const;
export const CritiqueRequestSchema = z.object({
  entityId: EntityIdSchema,
  trigger: z.enum(['finish_edit', 'state_change', 'on_demand']),
});
export const CritiqueNoteSchema = z.object({
  kind: z.enum(CRITIQUE_KINDS),
  text: z.string().min(1),
  /** Other entities the note is about (a duplicate, a contradicted relation's target). */
  entities: z.array(EntityIdSchema).default([]),
  /** The field the note is about, if any. */
  field: z.string().optional(),
  /** A taste rule the entity clashes with. */
  ruleId: z.string().optional(),
});
export type CritiqueNote = z.infer<typeof CritiqueNoteSchema>;
export const CritiqueResultSchema = z.object({ notes: z.array(CritiqueNoteSchema) });

// ── spread ──────────────────────────────────────────────────────────────────

/** Move keys (docs/EXPERIENCE.md §4). */
export const MOVES = [
  'fill',
  'vary',
  'oppose',
  'alloy',
  'push',
  'ground',
  'cost',
  'break',
  'name',
] as const;
export const MoveSchema = z.enum(MOVES);
export type Move = z.infer<typeof MoveSchema>;

/** Where a spread is aimed. */
export const SpotSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cell'), band: EntityIdSchema, lane: LaneSchema }),
  z.object({ type: z.literal('region'), band: EntityIdSchema, climate: ClimateSchema }),
  z.object({ type: z.literal('selection'), entities: z.array(EntityIdSchema).min(1) }),
  z.object({ type: z.literal('entity'), entity: EntityIdSchema }),
  z.object({ type: z.literal('note'), note: z.string(), entities: z.array(EntityIdSchema) }),
]);
export type Spot = z.infer<typeof SpotSchema>;

/** An axis of the spread field, e.g. "menace" low → high. */
export const AxisSchema = z.object({ label: z.string(), low: z.string(), high: z.string() });
export type Axis = z.infer<typeof AxisSchema>;

export const SpreadRequestSchema = z.object({
  spot: SpotSchema,
  move: MoveSchema,
  /** The optional one-line direction. */
  direction: z.string().max(300).optional(),
  count: z.number().int().min(1).max(16).default(12),
  axes: z.object({ x: AxisSchema, y: AxisSchema }).optional(),
  /** Taste rules switched on for this spread (default: all enabled rules). */
  ruleIds: z.array(z.string()).optional(),
});

export const CandidateSchema = z.object({
  /** Stable within the spread. */
  key: z.string(),
  /** The kind of entity it would become; `null` for findings (e.g. the Break move). */
  kind: EntityKindSchema.nullable(),
  name: z.string().min(1),
  identity: z.string(),
  description: z.string().optional(),
  fields: z.record(z.string(), FieldValueSchema).default({}),
  attributes: z.record(z.string(), z.number()).default({}),
  relations: z.array(RelationSchema).default([]),
  /** An existing entity this candidate changes (Ground, Cost, Name) rather than a new one. */
  about: EntityIdSchema.optional(),
  /** Position on the field's two axes, 0..1. */
  position: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  /** Generated without taste rules. Exactly one per spread. */
  wildcard: z.boolean().default(false),
  rationale: z.string().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;
export const SpreadResultSchema = z.object({
  axes: z.object({ x: AxisSchema, y: AxisSchema }),
  candidates: z.array(CandidateSchema),
});

// ── patterns ────────────────────────────────────────────────────────────────

export const JudgementSchema = z.object({
  candidate: z.object({
    name: z.string(),
    identity: z.string(),
    kind: EntityKindSchema.nullable(),
  }),
  verdict: z.enum(['keep', 'kill']),
  reason: z.string().optional(),
});
export const PatternsRequestSchema = z.object({ judgements: z.array(JudgementSchema).min(1) });
export const PatternsResultSchema = z.object({
  patterns: z.array(
    z.object({
      text: z.string().min(1),
      examples: z.array(z.string()).default([]),
      /** 0..1: how consistently the judgements show it. */
      strength: z.number().min(0).max(1),
      /** An existing pattern this updates. */
      updates: z.string().optional(),
    }),
  ),
});

// ── spec draft ──────────────────────────────────────────────────────────────

export const SpecDraftRequestSchema = z.object({
  entityIds: z.array(EntityIdSchema).min(1),
  name: z.string().min(1),
});
export const SpecDraftResultSchema = z.object({ title: z.string(), markdown: z.string() });

/** Request and result schemas per moment: the single table everything is typed from. */
export const MOMENT_SCHEMAS = {
  suggest_one: { request: SuggestRequestSchema, result: SuggestOneResultSchema },
  suggest_three: { request: SuggestRequestSchema, result: SuggestThreeResultSchema },
  fill_entity: { request: FillRequestSchema, result: FillResultSchema },
  critique: { request: CritiqueRequestSchema, result: CritiqueResultSchema },
  spread: { request: SpreadRequestSchema, result: SpreadResultSchema },
  patterns: { request: PatternsRequestSchema, result: PatternsResultSchema },
  spec_draft: { request: SpecDraftRequestSchema, result: SpecDraftResultSchema },
} as const satisfies Record<Moment, { request: z.ZodType; result: z.ZodType }>;

/** What a caller passes (defaults may be omitted). */
export type MomentRequest<M extends Moment> = z.input<(typeof MOMENT_SCHEMAS)[M]['request']>;
/** What a caller gets back (validated, defaults filled). */
export type MomentResult<M extends Moment> = z.output<(typeof MOMENT_SCHEMAS)[M]['result']>;
/** Streamed pieces: spreads stream candidates; other moments don't stream. */
export type MomentPartial<M extends Moment> = M extends 'spread' ? Candidate : never;
