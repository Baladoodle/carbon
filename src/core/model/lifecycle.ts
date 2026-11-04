import type { Entity } from './entity';
import { isEmptyValue } from './fields';
import type { EntityState } from './kinds';
import type { WorldSchema } from './schema';

/** Allowed transitions (docs/EXPERIENCE.md §8). */
export const TRANSITIONS: Record<EntityState, readonly EntityState[]> = {
  idea: ['shaped', 'graveyard'],
  shaped: ['decided', 'graveyard'],
  decided: ['exported'],
  exported: ['decided'],
  graveyard: ['idea'],
};

export const canTransition = (from: EntityState, to: EntityState): boolean =>
  TRANSITIONS[from].includes(to);

/** States in order of maturity, for accumulating requirements. */
const LADDER = ['idea', 'shaped', 'decided'] as const;

/**
 * Field keys an entity of this kind must have filled to *be in* `state`.
 * Requirements accumulate up the ladder; `decided` always needs `why`, and
 * `exported` needs what `decided` needs. `graveyard` needs nothing beyond a name.
 */
export function requiredFor(
  schema: WorldSchema,
  entity: Pick<Entity, 'kind'>,
  state: EntityState,
): string[] {
  if (state === 'graveyard') return [];
  const req = schema.kinds[entity.kind].required;
  const upto = state === 'exported' ? 'decided' : state;
  const keys: string[] = [];
  for (const step of LADDER) {
    keys.push(...req[step]);
    if (step === upto) break;
  }
  if (upto === 'decided') keys.push('why');
  return [...new Set(keys)];
}

/** The value of a common or kind field by key. */
export function fieldValue(entity: Entity, key: string): unknown {
  switch (key) {
    case 'name':
      return entity.name;
    case 'identity':
      return entity.identity;
    case 'description':
      return entity.description;
    case 'why':
      return entity.why;
    case 'tags':
      return entity.tags;
    default:
      return entity.fields[key];
  }
}

/** Required keys that are empty for `state` (empty list: the entity may be in it). */
export function missingFor(schema: WorldSchema, entity: Entity, state: EntityState): string[] {
  return requiredFor(schema, entity, state).filter((k) => isEmptyValue(fieldValue(entity, k)));
}
