import { z } from 'zod';
import { EntityIdSchema } from './ids';
import { EntityKindSchema } from './kinds';

/**
 * Field types a kind schema can use. A field's value lives in `entity.fields[key]`;
 * an absent key means "empty". Adding a field to a kind is data only.
 */
export const FIELD_TYPES = [
  'text', // one line
  'longtext', // markdown
  'number',
  'range', // { min, max }
  'enum', // one of `options`
  'list', // string[]
  'height', // a Y value: number, or "-inf" / "+inf" for the endless ends
  'ref', // an entity id, of one of `refKinds`
  'climate', // { temperature: {min,max}, moisture: {min,max} } within 0..1
  'steps', // [{ text, needs?: id[] }] — e.g. an item's acquisition route
  'boolean',
] as const;
export const FieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldDefSchema = z.object({
  /** Key in `entity.fields`; snake_case; must not collide with a common field. */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string(),
  type: FieldTypeSchema,
  /** One-line guidance, shown in the Bench and sent to the AI. */
  help: z.string().optional(),
  /** For `enum`. */
  options: z.array(z.string()).optional(),
  /** For `ref`: the kinds the id may point to. */
  refKinds: z.array(EntityKindSchema).optional(),
  /** For `number` and `range`. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** Value given to new entities. Must itself be valid for the field. */
  default: z.unknown().optional(),
  /** Whether the AI moments may suggest this field (default true). */
  ai: z.boolean().optional(),
});
export type FieldDef = z.infer<typeof FieldDefSchema>;

export const RangeSchema = z
  .object({ min: z.number(), max: z.number() })
  .refine((r) => r.min <= r.max, 'min must not exceed max');
export type Range = z.infer<typeof RangeSchema>;

export const HeightSchema = z.union([z.number(), z.literal('-inf'), z.literal('+inf')]);
export type Height = z.infer<typeof HeightSchema>;

const unit = z.number().min(0).max(1);
export const UnitRangeSchema = z
  .object({ min: unit, max: unit })
  .refine((r) => r.min <= r.max, 'min must not exceed max');
export const ClimateSchema = z.object({ temperature: UnitRangeSchema, moisture: UnitRangeSchema });
export type Climate = z.infer<typeof ClimateSchema>;

export const StepSchema = z.object({
  text: z.string(),
  /** Entities this step needs (materials, capabilities, items …). */
  needs: z.array(EntityIdSchema).optional(),
});
export const StepsSchema = z.array(StepSchema);
export type Step = z.infer<typeof StepSchema>;

/** Converts a height to a number (±Infinity for the endless ends). */
export const heightValue = (h: Height): number =>
  h === '-inf' ? -Infinity : h === '+inf' ? Infinity : h;

/** The zod schema for one field's value, built from its definition. */
export function fieldValueSchema(def: FieldDef): z.ZodType {
  switch (def.type) {
    case 'text':
    case 'longtext':
      return z.string();
    case 'number': {
      let s = z.number();
      if (def.min !== undefined) s = s.min(def.min);
      if (def.max !== undefined) s = s.max(def.max);
      return s;
    }
    case 'range': {
      const n = (): z.ZodNumber => {
        let s = z.number();
        if (def.min !== undefined) s = s.min(def.min);
        if (def.max !== undefined) s = s.max(def.max);
        return s;
      };
      return z
        .object({ min: n(), max: n() })
        .refine((r) => r.min <= r.max, 'min must not exceed max');
    }
    case 'enum':
      return def.options && def.options.length > 0
        ? z.enum(def.options as [string, ...string[]])
        : z.string();
    case 'list':
      return z.array(z.string());
    case 'height':
      return HeightSchema;
    case 'ref':
      return EntityIdSchema;
    case 'climate':
      return ClimateSchema;
    case 'steps':
      return StepsSchema;
    case 'boolean':
      return z.boolean();
  }
}

/** Whether a field value counts as empty (for required-field checks). */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
