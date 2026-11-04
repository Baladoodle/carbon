import type { Spot } from '@core/ai/moments';
import type { EntityId } from '@core/model/ids';
import { toast } from '../ui/Toast';
import { createStore, useStore } from './store';

/**
 * Shared UI state: which view is showing, the Bench, the entity in focus and
 * the selection. Views read and write it; it is not part of the world.
 */
export interface UiState {
  view: string;
  benchOpen: boolean;
  /** The entity on the Bench. */
  focus: EntityId | null;
  /** Selected entities (Codex rows, Column glyphs); a spread can start from them. */
  selection: EntityId[];
  /** The open overlay (`palette`, `ai-log`, or a package's own), or null. */
  overlay: string | null;
  /**
   * A spot handed to the Spread view (W5): a Column cell, a Climate region, a
   * Codex selection, an entity or a note. Set it together with the view —
   * `setUi({ view: 'spread', spot })`, or `startSpread(spot)` from
   * views/spread/start.ts — and the Spread view takes it and clears it.
   */
  spot: Spot | null;
}

const STORAGE_KEY = 'carbon.ui';

function initial(): UiState {
  const base: UiState = {
    view: 'column',
    benchOpen: true,
    focus: null,
    selection: [],
    overlay: null,
    spot: null,
  };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      const s = saved as Partial<UiState>;
      return {
        ...base,
        ...(typeof s.view === 'string' ? { view: s.view } : {}),
        ...(typeof s.benchOpen === 'boolean' ? { benchOpen: s.benchOpen } : {}),
      };
    }
  } catch {
    // fresh start
  }
  return base;
}

export const uiStore = createStore<UiState>(initial());

uiStore.subscribe(() => {
  const { view, benchOpen } = uiStore.get();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ view, benchOpen }));
  } catch {
    // storage unavailable
  }
});

export const useUi = <T>(selector: (s: UiState) => T): T => useStore(uiStore, selector);

export const setUi = (patch: Partial<UiState>): void => uiStore.set((s) => ({ ...s, ...patch }));

/** Shows a short message as a toast (kept for callers; same as `toast`). */
export function flash(text: string, tone: 'info' | 'error' = 'info'): void {
  toast(text, { tone });
}

/**
 * The one spread hand-off: aims the next spread at `spot` and opens the Spread
 * view (`space` on the Column, in the Codex and in Climate). The Spread view
 * adopts `ui.spot` and clears it.
 */
export const startSpreadAt = (spot: Spot): void => setUi({ spot, view: 'spread' });

/** Puts an entity on the Bench (and opens it). */
export const focusEntity = (id: EntityId | null): void =>
  setUi({ focus: id, ...(id ? { benchOpen: true } : {}) });
