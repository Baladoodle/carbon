import { createStore, useStore } from '../../state/store';
import type { Cursor } from './cursor';

/**
 * The Column's own UI state (not part of the world): zoom, the cursor, the
 * scroll position to come back to, and drags in progress. It lives for the
 * session so switching views and back keeps your place; the zoom is also
 * remembered across restarts.
 */
export interface ColumnUi {
  /** Pixels per scale unit (one decade far from 0). */
  pxPerU: number;
  cursor: Cursor | null;
  /** Scroll offset to restore when the view mounts again (null: centre on Y 0). */
  scrollTop: number | null;
  /** An edge being dragged, with its live height. */
  edgeDrag: { key: string; y: number } | null;
  /** A band being drawn on the ruler, in Y. */
  draw: { gap: string; from: number; to: number } | null;
}

export const ZOOM_MIN = 60;
export const ZOOM_MAX = 1600;
export const ZOOM_DEFAULT = 200;
const KEY = 'carbon.column.zoom';

function savedZoom(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : ZOOM_DEFAULT;
  } catch {
    return ZOOM_DEFAULT;
  }
}

export const columnStore = createStore<ColumnUi>({
  pxPerU: typeof localStorage === 'undefined' ? ZOOM_DEFAULT : savedZoom(),
  cursor: null,
  scrollTop: null,
  edgeDrag: null,
  draw: null,
});

let lastZoom = columnStore.get().pxPerU;
columnStore.subscribe(() => {
  const z = columnStore.get().pxPerU;
  if (z === lastZoom) return;
  lastZoom = z;
  try {
    localStorage.setItem(KEY, String(z));
  } catch {
    // storage unavailable
  }
});

export const setColumn = (patch: Partial<ColumnUi>): void =>
  columnStore.set((s) => ({ ...s, ...patch }));

export const useColumn = <T>(selector: (s: ColumnUi) => T): T => useStore(columnStore, selector);

export const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
