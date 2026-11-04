import { findingNotes } from '@core/spreads/findings';
import { publishNotes } from '../../state/notes';
import { worldStore } from '../../state/world';

let started = false;

/**
 * Publishes kept Break findings as notes (source `spreads`), so they show in
 * the Column margin, on the Bench and in the status line, whatever view is
 * open. Re-computed only when the spreads change.
 */
export function startFindingNotes(): void {
  if (started) return;
  started = true;
  let last: unknown = null;
  const publish = (): void => {
    const w = worldStore.get().world;
    if (!w || w.spreads === last) return;
    last = w.spreads;
    publishNotes('spreads', findingNotes(w));
  };
  worldStore.subscribe(publish);
  publish();
}
