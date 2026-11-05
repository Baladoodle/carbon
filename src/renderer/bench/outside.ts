import { on } from '../bridge';

/**
 * Which entities changed from outside carbon (docs/SYSTEM.md §4: an edit by
 * hand or by Claude Code, picked up by the file watcher, or an agent's command
 * over the agent socket, docs/MCP.md), so the Bench can
 * tell such a change from its own when it lands in a field you're typing in.
 * Every outside patch bumps a counter and stamps the entities it touches; a
 * fresh snapshot (an outside change the store couldn't express as a patch)
 * stamps every entity.
 */
let seq = 0;
let resetAt = 0;
const touched = new Map<string, number>();
/** Entities whose latest outside change was an agent's. */
const byAgent = new Set<string>();
let started = false;

/** Starts listening (once). The world mirror listens first, so a stamp is set before React renders the change. */
export function watchOutside(): void {
  if (started) return;
  started = true;
  on('world:patch', (e) => {
    // An outside agent's command (docs/MCP.md) counts as outside too: it isn't your keypress.
    const agent = e.cause === 'command' && e.by === 'agent';
    if (e.cause !== 'external' && !agent) return;
    seq++;
    for (const op of e.patch) {
      const [root, id] = op.path;
      if (root === 'entities' && typeof id === 'string') {
        touched.set(id, seq);
        if (agent) byAgent.add(id);
        else byAgent.delete(id);
      }
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

/** Who made the entity's latest outside change: an agent (over the agent socket) or something outside carbon. */
export const outsideBy = (entityId: string): 'agent' | 'outside' =>
  byAgent.has(entityId) && (touched.get(entityId) ?? 0) >= resetAt ? 'agent' : 'outside';
