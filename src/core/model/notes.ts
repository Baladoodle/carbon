import { z } from 'zod';
import { EntityIdSchema } from './ids';

/**
 * A note in the margin: from a mechanical check (W6) or an AI critique (W4).
 * The Column, the Bench and the status line all read these.
 */
export const NoteSchema = z.object({
  /** Stable across runs while the inputs are the same (e.g. `check:dangling:item-x:made_from`). */
  id: z.string(),
  source: z.enum(['check', 'ai']),
  /** The check id or critique kind, e.g. `material-nowhere`, `duplicate`. */
  kind: z.string(),
  severity: z.enum(['info', 'warn', 'error']),
  text: z.string(),
  entities: z.array(EntityIdSchema),
  /** Height on the Column, when the note has one. */
  y: z.number().optional(),
  /** Hash of the inputs; a dismissal holds until this changes. */
  inputsHash: z.string().optional(),
});
export type Note = z.infer<typeof NoteSchema>;
