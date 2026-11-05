import { createStore, useStore } from '../state/store';

/**
 * Resizable panes: the pure math (limits, drag, keyboard steps, collapse) and
 * the sizes the viewer chose. Sizes are this machine's, like the Codex's
 * column widths: they live in the renderer's local storage, which Electron
 * keeps in userData, and never in the world directory, the undo history or a
 * file write.
 */

/** A pane's limits along its axis, in px. `max` is already resolved for the space it has now. */
export interface PaneLimits {
  min: number;
  max: number;
  /** Dragging or stepping below `min` hides the pane (the Bench: as `b` does). */
  collapsible: boolean;
}

/** The edge that resizes: `start` is a pane's left (x) or top (y) edge, `end` its right or bottom. */
export type PaneEdge = 'start' | 'end';

/** Keyboard steps on a focused edge: arrows, and with shift. */
export const STEP = 16;
export const BIG_STEP = 64;

/** A drag that ends this far below the minimum collapses a collapsible pane. */
export const COLLAPSE_BELOW = 0.5;

/** The size within the limits (a max under the min yields the min). */
export function clampSize(size: number, l: Pick<PaneLimits, 'min' | 'max'>): number {
  return Math.round(Math.max(l.min, Math.min(Math.max(l.min, l.max), size)));
}

/**
 * The raw size while dragging: the size the drag started at, plus how far the
 * pointer moved, toward the outside of the pane. The Bench's edge is its start
 * (left) edge, so moving left widens it.
 */
export const dragSize = (start: number, delta: number, edge: PaneEdge): number =>
  edge === 'start' ? start - delta : start + delta;

export interface Settled {
  /** The size to keep (within the limits). */
  size: number;
  /** The pane hides; its kept size stays what it was, for when it comes back. */
  collapse: boolean;
}

/** Whether a raw (unclamped) size means "hide it". */
export const collapsing = (raw: number, l: PaneLimits): boolean =>
  l.collapsible && raw < l.min * COLLAPSE_BELOW;

/** Where a drag that ended at `raw` leaves the pane. */
export function settle(raw: number, l: PaneLimits): Settled {
  return { size: clampSize(raw, l), collapse: collapsing(raw, l) };
}

/**
 * One keyboard (or palette) step from `current`: +1 widens, −1 narrows. Narrowing
 * a collapsible pane that is already at its minimum hides it.
 */
export function stepSize(current: number, dir: 1 | -1, big: boolean, l: PaneLimits): Settled {
  if (dir < 0 && l.collapsible && current <= l.min)
    return { size: clampSize(current, l), collapse: true };
  return { size: clampSize(current + dir * (big ? BIG_STEP : STEP), l), collapse: false };
}

/**
 * Which way an arrow key moves an edge's pane: +1 widens, −1 narrows, 0 is not
 * this axis. The arrow moves the edge itself, so on a start edge the arrow
 * pointing out of the pane (left, up) widens it.
 */
export function arrowDir(key: string, axis: 'x' | 'y', edge: PaneEdge): 1 | -1 | 0 {
  const [less, more] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  const out = edge === 'start' ? less : more;
  const into = edge === 'start' ? more : less;
  return key === out ? 1 : key === into ? -1 : 0;
}

/** A max given as px or as a share of the space the pane has. */
export type PaneMax = number | ((space: { window: number; parent: number }) => number);
export const resolveMax = (
  max: PaneMax | undefined,
  space: { window: number; parent: number },
): number => (max === undefined ? Infinity : typeof max === 'number' ? max : max(space));

// ── The sizes the viewer chose ──────────────────────────────────────────────

export const PANES_KEY = 'carbon.panes';
export type PaneSizes = Readonly<Record<string, number>>;

/** Stored sizes from their text; anything unreadable is dropped, never the rest. */
export function parseSizes(text: string | null): PaneSizes {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? 'null');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw))
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100_000) out[k] = Math.round(v);
  return out;
}

/** `size: null` forgets the pane's size: it goes back to its default. */
export function withSize(sizes: PaneSizes, id: string, size: number | null): PaneSizes {
  if (size === null) {
    if (!(id in sizes)) return sizes;
    const { [id]: _gone, ...rest } = sizes;
    return rest;
  }
  return sizes[id] === size ? sizes : { ...sizes, [id]: size };
}

function load(): PaneSizes {
  try {
    return parseSizes(localStorage.getItem(PANES_KEY));
  } catch {
    return {};
  }
}

export const paneStore = createStore<PaneSizes>(typeof localStorage === 'undefined' ? {} : load());

paneStore.subscribe(() => {
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(paneStore.get()));
  } catch {
    // storage unavailable
  }
});

export const setPaneSize = (id: string, size: number | null): void =>
  paneStore.set((s) => withSize(s, id, size));

export const usePaneSize = (id: string): number | undefined => useStore(paneStore, (s) => s[id]);

// ── Mounted panes, for "Widen panel" and "Narrow panel" ─────────────────────

export interface PaneHandle {
  id: string;
  element: () => HTMLElement | null;
  /** One palette step (the big one). */
  step: (dir: 1 | -1) => void;
}

const mounted = new Map<string, PaneHandle>();
let lastFocused: string | null = null;

export function registerPane(p: PaneHandle): () => void {
  mounted.set(p.id, p);
  return () => {
    if (mounted.get(p.id) === p) mounted.delete(p.id);
  };
}

/** Overlays (the palette, dialogs, menus) don't count as leaving a pane. */
const OVERLAY = '[role="dialog"], [data-radix-popper-content-wrapper], .palette-scrim';

/** Remembers the pane focus was last in, so the palette can act on it. */
export function notePaneFocus(target: EventTarget | null): void {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return;
  if (target.closest(OVERLAY)) return;
  lastFocused = target.closest<HTMLElement>('[data-pane]')?.dataset['pane'] ?? null;
}

/**
 * The pane the palette's "Widen panel" acts on: the one holding focus (or
 * holding it before the palette opened), else the Bench, else the first one
 * mounted.
 */
export function nearestPane(): PaneHandle | null {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  for (const p of mounted.values()) if (active && p.element()?.contains(active)) return p;
  const last = lastFocused === null ? undefined : mounted.get(lastFocused);
  if (last) return last;
  return mounted.get('bench') ?? mounted.values().next().value ?? null;
}

export const anyPane = (): boolean => mounted.size > 0;
