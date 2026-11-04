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
   * A spread asked for from another surface (`space` on a Column cell, Codex
   * rows, a Climate region), for the Spread view to pick up. `seq` changes on
   * every request, so asking twice for the same spot still registers.
   * Added by W1 (column); see docs/build-notes/column.md.
   */
  spreadRequest: { spot: Spot; seq: number } | null;
}

const STORAGE_KEY = 'carbon.ui';

function initial(): UiState {
  const base: UiState = {
    view: 'column',
    benchOpen: true,
    focus: null,
    selection: [],
    overlay: null,
    spreadRequest: null,
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

/** Puts an entity on the Bench (and opens it). */
export const focusEntity = (id: EntityId | null): void =>
  setUi({ focus: id, ...(id ? { benchOpen: true } : {}) });

let spreadSeq = 0;

/** Asks for a spread at a spot and switches to the Spread view (W5 reads `spreadRequest`). */
export const startSpread = (spot: Spot): void =>
  setUi({ spreadRequest: { spot, seq: ++spreadSeq }, view: 'spread' });
