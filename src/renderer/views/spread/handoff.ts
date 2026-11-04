import { SpotSchema, type Spot } from '@core/ai/moments';
import type { UiState } from '../../state/ui';

/**
 * Reads a spot handed over through UI state. The contract is `ui.spot`
 * (start.ts). Two other packages built the same hand-off under other names
 * in parallel — W1's `ui.spreadRequest: { spot, seq }` and W2's
 * `ui.spreadSpot` — so those are accepted too until integration settles on
 * one. Everything is validated: a malformed spot is ignored.
 */
export function handedSpot(ui: UiState): Spot | null {
  const loose = ui as unknown as Record<string, unknown>;
  const request = loose.spreadRequest as { spot?: unknown } | null | undefined;
  for (const raw of [ui.spot, loose.spreadSpot, request?.spot]) {
    if (raw === null || raw === undefined) continue;
    const r = SpotSchema.safeParse(raw);
    if (r.success) return r.data;
  }
  return null;
}

/** What to set to clear every hand-off key that's present. */
export function clearHandoff(ui: UiState): Partial<UiState> {
  const loose = ui as unknown as Record<string, unknown>;
  return {
    spot: null,
    ...('spreadSpot' in loose ? ({ spreadSpot: null } as object) : {}),
    ...('spreadRequest' in loose ? ({ spreadRequest: null } as object) : {}),
  };
}

/** A key that changes whenever a new hand-off arrives (W1's `seq` included). */
export function handoffKey(ui: UiState): string {
  const loose = ui as unknown as Record<string, unknown>;
  const spot = handedSpot(ui);
  if (!spot) return '';
  const seq = (loose.spreadRequest as { seq?: unknown } | null | undefined)?.seq;
  return `${JSON.stringify(spot)}#${typeof seq === 'number' ? seq : ''}`;
}
