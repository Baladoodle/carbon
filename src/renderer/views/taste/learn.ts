import { cmd } from '@core/commands/registry';
import { judgementCount, patternsDue, patternsRequest } from '@core/taste/patterns';
import { ai } from '../../ai/client';
import { createStore, useStore } from '../../state/store';
import { setUi } from '../../state/ui';
import { currentWorld, transact } from '../../state/world';
import { toast } from '../../ui';

/**
 * The `patterns` moment (docs/EXPERIENCE.md §5): after every 25 judgements,
 * or on demand in Taste. One run at a time; results land as proposed patterns
 * (one undo step) for you to promote or dismiss.
 */

export const learnStore = createStore<{ running: boolean; error: string | null }>({
  running: false,
  error: null,
});
export const useLearning = (): { running: boolean; error: string | null } =>
  useStore(
    learnStore,
    (s) => s,
    (a, b) => a.running === b.running && a.error === b.error,
  );

/** Runs the patterns moment now. Resolves to the number of patterns learned, or null on failure. */
export async function learnPatterns(): Promise<number | null> {
  if (learnStore.get().running) return null;
  const world = currentWorld();
  if (!world) return null;
  const request = patternsRequest(world);
  if (!request) {
    learnStore.set({ running: false, error: 'No judgements yet' });
    return null;
  }
  const judged = judgementCount(world);
  learnStore.set({ running: true, error: null });
  const out = await ai.run('patterns', request);
  if (!out.ok) {
    learnStore.set({ running: false, error: out.error.message });
    return null;
  }
  const r = await transact('Learn patterns', [
    cmd('taste.learnPatterns', {
      patterns: out.result.patterns,
      judged,
      at: new Date().toISOString(),
    }),
  ]);
  learnStore.set({ running: false, error: r.ok ? null : r.error.message });
  return r.ok ? out.result.patterns.length : null;
}

/** Called after every judgement: runs the moment when 25 new ones have built up. */
export function learnIfDue(): void {
  const world = currentWorld();
  if (!world || learnStore.get().running || !patternsDue(world)) return;
  void learnPatterns().then((n) => {
    if (n)
      toast(`${n} pattern${n === 1 ? '' : 's'} to review`, {
        tone: 'ai',
        action: { label: 'Taste', run: () => setUi({ view: 'taste' }) },
      });
  });
}
