import type { World } from '../model/world';
import { compileExpression, type NumbersAnalysis } from './engine';
import { relevantFormulas } from './index';
import { entityOf } from './types';
import { formatValue } from './values';

/**
 * One live consequence of an entity's attributes (EXPERIENCE §3, the Bench):
 * a formula that reads the entity, with its value for this entity.
 *
 * - A constant shows its value (it already reads this entity's kind or
 *   attributes, e.g. `armor_total = sum(items, .defense)`).
 * - A function of one entity that accepts this entity's kind is applied to
 *   it: `ttk(c)` on a creature shows `ttk(Cinder Wasp) = 4`.
 * - Other functions (several parameters, numbers only) have no single value
 *   for the entity and are left out.
 * - Only numbers and true/false are consequences: a constant that is a list
 *   or an entity (`armor = items where …`) is a query, not a consequence of
 *   this entity's numbers, and is left out. Errors always show.
 */
export interface Consequence {
  name: string;
  /** What was evaluated: the constant's name, or `f(Entity Name)`. */
  label: string;
  value?: string;
  error?: string;
}

export function entityConsequences(
  analysis: NumbersAnalysis,
  world: World,
  entityId: string,
): Consequence[] {
  const e = world.entities[entityId];
  if (!e) return [];
  const name = (id: string): string | undefined => world.entities[id]?.name;
  const out: Consequence[] = [];
  for (const f of relevantFormulas(analysis, world, entityId)) {
    const def = analysis.byName.get(f.name);
    if (!def) continue;
    if (def.kind === 'const') {
      if (f.error === undefined && typeof f.plain !== 'number' && typeof f.plain !== 'boolean')
        continue;
      out.push({
        name: f.name,
        label: f.name,
        ...(f.value !== undefined ? { value: f.value } : {}),
        ...(f.error !== undefined ? { error: f.error } : {}),
      });
      continue;
    }
    const c = compileExpression(analysis, `${f.name}(it)`, {}, entityOf(e.kind));
    if (!c.ok) continue;
    const r = c.run({}, { $: 'entity', id: e.id });
    if (r.ok && typeof r.value !== 'number' && typeof r.value !== 'boolean') continue;
    const label = `${f.name}(${e.name})`;
    out.push(
      r.ok
        ? { name: f.name, label, value: formatValue(r.value, { name }) }
        : { name: f.name, label, error: r.error.message },
    );
  }
  return out;
}
