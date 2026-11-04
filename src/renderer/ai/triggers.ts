import { useEffect } from 'react';
import type { World } from '@core/model/world';
import { benchAi, settled } from '../bench/controller';
import { uiStore } from '../state/ui';
import { currentWorld, worldStore } from '../state/world';
import { ai } from './client';
import { createFinishTriggers } from './finish';

/**
 * The automatic critique triggers (EXPERIENCE §5), for the whole app: finish
 * editing (focus leaves an entity after changes; the Bench also calls
 * `finishEditing` when it loses focus, closes, or on `ctrl+s`) and state
 * changes made in carbon. `?` (on demand) is the Bench's. Automatic triggers
 * stay quiet while the AI is off or paused; the gateway's content-hash cache
 * means an unchanged request is never sent twice.
 */
const triggers = createFinishTriggers({
  getWorld: currentWorld,
  critique: (id, trigger) => benchAi.critique(id, trigger),
  settled,
  allowed: () => {
    const s = ai.status();
    return s.enabled && !s.paused;
  },
});

/** Finishing the edit of an entity that stays in focus (Bench blur, close, `ctrl+s`). */
export const finishEditing = (id: string): Promise<void> => triggers.finish(id);

/** Mounted once, with the status line. */
export function useCritiqueTriggers(): void {
  useEffect(() => {
    void triggers.focusChanged(uiStore.get().focus);
    return uiStore.subscribe(() => void triggers.focusChanged(uiStore.get().focus));
  }, []);

  // State changes made in carbon (not the first snapshot, not after a gap).
  useEffect(() => {
    let prev: World['entities'] | null = null;
    let rev = -1;
    return worldStore.subscribe(() => {
      const s = worldStore.get();
      if (!s.world || s.rev === rev) return;
      const next = s.world.entities;
      const continuous = prev !== null && s.rev === rev + 1;
      const before = prev;
      prev = next;
      rev = s.rev;
      if (!continuous || !before || before === next) return;
      // Patches share unchanged entities, so only changed objects are compared.
      const changed: string[] = [];
      for (const id in next) {
        const e = next[id];
        const was = before[id];
        if (e && was && e !== was && e.state !== was.state) changed.push(id);
      }
      if (changed.length > 0) void triggers.statesChanged(changed);
    });
  }, []);
}
