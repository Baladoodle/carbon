import { on } from '../bridge';

/**
 * Which entities changed from outside carbon (docs/SYSTEM.md §4: an edit by
 * hand or by Claude Code, picked up by the file watcher), so the Bench can
 * tell such a change from its own when it lands in a field you're typing in.
 * Every outside patch bumps a counter and stamps the entities it touches; a
 * fresh snapshot (an outside change the store couldn't express as a patch)
 * stamps every entity.
 */
let seq = 0;
let resetAt = 0;
const touched = new Map<string, number>();
let started = false;

/** Starts listening (once). The world mirror listens first, so a stamp is set before React renders the change. */
export function watchOutside(): void {
  if (started) return;
  started = true;
  on('world:patch', (e) => {
    if (e.cause !== 'external') return;
    seq++;
    for (const op of e.patch) {
      const [root, id] = op.path;
      if (root === 'entities' && typeof id === 'string') touched.set(id, seq);
    }
  });
  on('world:reset', () => {
    seq++;
    resetAt = seq;
  });
}

/** A stamp that changes whenever something outside carbon changes the entity. */
export const outsideStamp = (entityId: string): number =>
  Math.max(touched.get(entityId) ?? 0, resetAt);
