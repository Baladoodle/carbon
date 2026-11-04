import type { z } from 'zod';
import type { World } from '../model/world';
import type { Result } from '../util/result';
import type { Patch } from './patch';

/** What a command may know besides the world and its payload. Pure inputs only. */
export interface CommandContext {
  /** The current time (ISO 8601), stamped into `updated`/`created`. */
  now: string;
}

/**
 * A command definition: a payload schema and a pure `plan` that turns
 * (world, payload) into a patch. `applyCommand` validates the payload, applies
 * the patch, computes its inverse and checks the result is still valid.
 */
export interface CommandDef<P extends z.ZodType = z.ZodType> {
  payload: P;
  /** A short human label, e.g. for the undo history ("Rename Glass Lung"). */
  label: (payload: z.infer<P>, world: World) => string;
  plan: (world: World, payload: z.infer<P>, ctx: CommandContext) => Result<Patch>;
}

/** Identity helper that keeps the payload type for `plan` and `label`. */
export const defineCommand = <P extends z.ZodType>(def: CommandDef<P>): CommandDef<P> => def;
