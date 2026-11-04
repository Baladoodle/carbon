import { SpotSchema, type Spot } from '@core/ai/moments';
import type { UiState } from '../../state/ui';

/**
 * Reads the spot handed over through `ui.spot` (set by `startSpreadAt` in
 * state/ui.ts, or `startSpread` in start.ts). It is validated: a malformed
 * spot is ignored.
 */
export function handedSpot(ui: UiState): Spot | null {
  if (ui.spot === null) return null;
  const r = SpotSchema.safeParse(ui.spot);
  return r.success ? r.data : null;
}

/** What to set to clear the hand-off once the Spread view has taken it. */
export function clearHandoff(): Partial<UiState> {
  return { spot: null };
}

/** A key that changes whenever a new hand-off arrives. */
export function handoffKey(ui: UiState): string {
  const spot = handedSpot(ui);
  return spot ? JSON.stringify(spot) : '';
}
