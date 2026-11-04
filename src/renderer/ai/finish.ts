import type { EntityId } from '@core/model/ids';
import type { World } from '@core/model/world';

type Trigger = 'finish_edit' | 'state_change';

export interface FinishDeps {
  getWorld: () => World | null | undefined;
  /** Runs the critique moment and publishes its notes (the Bench's controller). */
  critique: (id: EntityId, trigger: Trigger) => Promise<void>;
  /** Resolves once the edits in flight for an entity have landed. */
  settled: (id: EntityId) => Promise<unknown>;
  /** Automatic critiques stay quiet while the AI is off or paused. */
  allowed: () => boolean;
}

/**
 * When an automatic critique runs (EXPERIENCE §5), in one place for the whole
 * app. "Finishing an edit" means the entity changed since it came into focus
 * (or since its last critique) and then: focus moved to another entity, the
 * Bench lost focus or closed, or `ctrl+s`. A state change made in carbon
 * critiques too. An entity you didn't change is never sent.
 *
 * The baseline is the entity's `updated` stamp, so edits made anywhere (the
 * Bench, the Codex, Climate, an accepted suggestion) count, and the edit that
 * a blur commits is awaited (`settled`) before the comparison.
 */
export function createFinishTriggers(deps: FinishDeps) {
  /** The `updated` stamp of each tracked entity at its baseline. */
  const baseline = new Map<EntityId, string>();
  let focus: EntityId | null = null;

  const stamp = (id: EntityId): string | undefined => deps.getWorld()?.entities[id]?.updated;

  /** Finishing an edit of `id`: critique it if it changed since its baseline. */
  async function finish(id: EntityId): Promise<void> {
    await deps.settled(id);
    const e = deps.getWorld()?.entities[id];
    const base = baseline.get(id);
    if (!e || base === undefined || e.updated === base || e.state === 'graveyard') return;
    if (!deps.allowed()) return;
    baseline.set(id, e.updated);
    await deps.critique(id, 'finish_edit');
  }

  /** Focus moved: finish the entity you left, start tracking the new one. */
  function focusChanged(next: EntityId | null): Promise<void> {
    if (next === focus) return Promise.resolve();
    const left = focus;
    focus = next;
    if (next) {
      const s = stamp(next);
      if (s !== undefined) baseline.set(next, s);
    }
    if (!left) return Promise.resolve();
    return finish(left).then(() => {
      if (focus !== left) baseline.delete(left);
    });
  }

  /** States changed in carbon: critique each (not into the graveyard). */
  function statesChanged(ids: readonly EntityId[]): Promise<void> {
    if (!deps.allowed()) return Promise.resolve();
    const runs: Promise<void>[] = [];
    for (const id of ids) {
      const e = deps.getWorld()?.entities[id];
      if (!e || e.state === 'graveyard') continue;
      // The state change is the finished edit: leaving afterwards doesn't send it again.
      if (baseline.has(id)) baseline.set(id, e.updated);
      runs.push(deps.critique(id, 'state_change'));
    }
    return Promise.all(runs).then(() => undefined);
  }

  return { finish, focusChanged, statesChanged, baselineOf: (id: EntityId) => baseline.get(id) };
}

export type FinishTriggers = ReturnType<typeof createFinishTriggers>;
