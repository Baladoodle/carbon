import type { Entity } from '../model/entity';
import { isEmptyValue } from '../model/fields';
import type { EntityState } from '../model/kinds';
import { fieldValue, requiredFor } from '../model/lifecycle';
import type { WorldSchema } from '../model/schema';

/**
 * Which of an entity's fields the Bench shows (docs/VISUAL.md §6.7). An empty
 * optional field is noise: it reads like a blank form. A field shows when it
 * has a value, when the entity's current or next state needs it, or when the
 * caller has a reason (`also`: a focused field, a proposal waiting in it, one
 * you just revealed). Everything else waits behind one "Field" affordance.
 */

/** The state an entity is heading for: the one whose requirements matter next. */
export const NEXT_STATE: Record<EntityState, EntityState> = {
  idea: 'shaped',
  shaped: 'decided',
  decided: 'exported',
  exported: 'exported',
  graveyard: 'idea',
};

/** Keys the current and next state need, filled or not. */
export function neededKeys(schema: WorldSchema, entity: Entity): Set<string> {
  const now = entity.state === 'graveyard' ? [] : requiredFor(schema, entity, entity.state);
  return new Set([...now, ...requiredFor(schema, entity, NEXT_STATE[entity.state])]);
}

/** Splits `keys` (in order) into the fields shown and the ones collapsed. */
export function splitFields(
  schema: WorldSchema,
  entity: Entity,
  keys: readonly string[],
  also: ReadonlySet<string> = new Set(),
): { shown: string[]; hidden: string[] } {
  const needed = neededKeys(schema, entity);
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const k of keys) {
    if (needed.has(k) || also.has(k) || !isEmptyValue(fieldValue(entity, k))) shown.push(k);
    else hidden.push(k);
  }
  return { shown, hidden };
}
