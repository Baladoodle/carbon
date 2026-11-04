import { isPlainObject, deepEqual } from '../util/json';
import type { Patch } from './patch';

/**
 * A patch that turns `before` into `after`, at entity / spread / section
 * granularity (e.g. after an external edit reloads files). Unchanged branches
 * produce no ops. `applyPatch(before, diffWorlds(before, after))` deep-equals `after`.
 */
export function diffWorlds<T extends Record<string, unknown>>(before: T, after: T): Patch {
  const patch: Patch = [];
  const keyed = new Set(['entities', 'spreads']);
  for (const section of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[section];
    const b = after[section];
    if (a === b || deepEqual(a, b)) continue;
    if (keyed.has(section) && isPlainObject(a) && isPlainObject(b)) {
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(id in b)) patch.push({ op: 'remove', path: [section, id] });
        else if (!(id in a) || !deepEqual(a[id], b[id]))
          patch.push({ op: 'set', path: [section, id], value: b[id] });
      }
    } else if (!(section in after)) patch.push({ op: 'remove', path: [section] });
    else patch.push({ op: 'set', path: [section], value: b });
  }
  return patch;
}
