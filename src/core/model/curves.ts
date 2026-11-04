import { z } from 'zod';
import { EntityKindSchema } from './kinds';

/**
 * A curve in the Numbers view (`numbers/curves.json`, owned by W3): a formula
 * plotted over the bands, the tiers or an attribute's range, with entities as
 * dots and an optional intent curve you drag. The expressions are carbon's
 * expression language; `x` is the band (an entity), the tier or the attribute
 * value, and in `dots.value` the entity is `it`.
 */
export const CurveAxisSchema = z.discriminatedUnion('axis', [
  z.object({ axis: z.literal('band') }),
  z.object({ axis: z.literal('tier') }),
  z.object({
    axis: z.literal('attribute'),
    kind: EntityKindSchema,
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    min: z.number().refine(Number.isFinite),
    max: z.number().refine(Number.isFinite),
  }),
]);
export type CurveAxis = z.infer<typeof CurveAxisSchema>;

/** A control point of an intent curve: `x` is a band id on the band axis, else a number. */
export const IntentPointSchema = z.object({
  x: z.union([z.number().refine(Number.isFinite), z.string()]),
  y: z.number().refine(Number.isFinite),
});
export type IntentPoint = z.infer<typeof IntentPointSchema>;

export const CurveSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** The plotted expression, in terms of `x`, e.g. `band_defense(x)`. */
  y: z.string(),
  over: CurveAxisSchema,
  /** Entities shown as dots: a query (a list of entities) and the value per entity. */
  dots: z
    .object({
      query: z.string(),
      /** In terms of `it`; when absent, a dot sits on the curve at its x. */
      value: z.string().optional(),
    })
    .optional(),
  /** The dashed intent curve's control points. */
  intent: z.array(IntentPointSchema).optional(),
  /** How far off the intent a dot may be, relative to the intent (default 0.25). */
  tolerance: z.number().positive().optional(),
});
export type Curve = z.infer<typeof CurveSchema>;
