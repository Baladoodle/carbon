import type { Move, Spot } from '@core/ai/moments';
import { setUi } from '../../state/ui';
import { patchSetup } from './session';

/**
 * The hand-off from other views to the Spread view (docs/EXPERIENCE.md §4).
 *
 * Any view starts a spread at its selection with `space` by calling
 * `startSpread(spot)` — or, without importing this folder, by setting UI
 * state: `setUi({ view: 'spread', spot })`. The Spread view adopts the spot
 * (choosing a move that can aim at it), clears `ui.spot`, and waits for a
 * move key or `enter`. Spots:
 *
 *  - Column cell:     `{ type: 'cell', band, lane }`
 *  - Climate region:  `{ type: 'region', band, climate }`
 *  - Codex selection: `{ type: 'selection', entities }`
 *  - one entity:      `{ type: 'entity', entity }`
 *  - a note:          `{ type: 'note', note, entities }`
 *
 * With no spot handed over, the Spread view uses the selection (several →
 * `selection`, one → `entity`) or else the entity on the Bench.
 */
export function startSpread(spot: Spot, move?: Move): void {
  if (move) patchSetup({ move });
  setUi({ view: 'spread', spot });
}
