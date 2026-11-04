import { useEffect } from 'react';
import type { EntityState } from '@core/model/kinds';
import { useActions } from '../actions';
import { uiStore } from '../state/ui';
import { currentWorld, worldStore } from '../state/world';
import { toast } from '../ui';
import { ai } from './client';
import { critique } from './moments';

/**
 * When critique runs (EXPERIENCE §5): when you finish editing an entity
 * (focus leaves it after changes, or ctrl+s), when its state changes, or on
 * demand (`?`). Automatic triggers stay quiet while the AI is off or paused;
 * the content-hash cache means an unchanged entity is never sent twice.
 */

const autoAllowed = (): boolean => {
  const s = ai.status();
  return s.enabled && !s.paused;
};

const ON_DEMAND_EMPTY = (name: string): string => `No notes on ${name}`;

async function critiqueNow(id: string): Promise<void> {
  const name = currentWorld()?.entities[id]?.name ?? id;
  const out = await critique(id, 'on_demand');
  if (!out.ok) {
    if (out.error.code !== 'cancelled') toast(out.error.message, { tone: 'error' });
  } else if (out.result.notes.length === 0) toast(ON_DEMAND_EMPTY(name), { tone: 'ai' });
}

/** Mounted once, with the status line. */
export function useCritiqueTriggers(): void {
  // Finish editing: focus leaves an entity whose `updated` changed while it had focus.
  useEffect(() => {
    let focus = uiStore.get().focus;
    let stamp = focus ? currentWorld()?.entities[focus]?.updated : undefined;
    return uiStore.subscribe(() => {
      const next = uiStore.get().focus;
      if (next === focus) return;
      const left = focus;
      const before = stamp;
      focus = next;
      stamp = next ? currentWorld()?.entities[next]?.updated : undefined;
      if (!left || !autoAllowed()) return;
      const now = currentWorld()?.entities[left];
      if (now && before !== undefined && now.updated !== before && now.state !== 'graveyard')
        void critique(left, 'finish_edit');
    });
  }, []);

  // State changes, made in carbon (not the first snapshot).
  useEffect(() => {
    let states: Map<string, EntityState> | null = null;
    let rev = -1;
    const read = (): Map<string, EntityState> =>
      new Map(Object.values(worldStore.get().world?.entities ?? {}).map((e) => [e.id, e.state]));
    return worldStore.subscribe(() => {
      const s = worldStore.get();
      if (!s.world) return;
      const next = read();
      const continuous = states !== null && s.rev === rev + 1;
      const prev = states;
      states = next;
      rev = s.rev;
      if (!continuous || !prev || !autoAllowed()) return;
      for (const [id, state] of next)
        if (prev.has(id) && prev.get(id) !== state && state !== 'graveyard')
          void critique(id, 'state_change');
    });
  }, []);

  useActions([
    {
      id: 'ai.critique',
      label: 'Critique the entity on the Bench',
      group: 'AI',
      keys: ['?'],
      enabled: () => uiStore.get().focus !== null,
      run: () => {
        const id = uiStore.get().focus;
        if (id) void critiqueNow(id);
      },
    },
    {
      id: 'ai.critique-save',
      label: 'Finish editing (critique)',
      group: 'AI',
      keys: ['ctrl+s'],
      inInputs: true,
      hidden: true,
      enabled: () => uiStore.get().focus !== null,
      run: () => {
        const id = uiStore.get().focus;
        if (id && autoAllowed()) void critique(id, 'finish_edit');
      },
    },
  ]);
}
