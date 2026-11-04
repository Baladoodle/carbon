import type { World } from '../model/world';
import type { Result } from '../util/result';
import { applyChecked } from './apply';
import type { Patch } from './patch';

/** One undoable step: a command, or a transaction of several. */
export interface HistoryEntry {
  label: string;
  patch: Patch;
  inverse: Patch;
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
  limit: number;
}

export const emptyHistory = (limit = 500): History => ({ past: [], future: [], limit });

/** Records a new step; clears the redo stack; drops the oldest beyond the limit. */
export function record(h: History, entry: HistoryEntry): History {
  const past = [...h.past, entry];
  return {
    ...h,
    past: past.length > h.limit ? past.slice(past.length - h.limit) : past,
    future: [],
  };
}

export interface Step {
  world: World;
  history: History;
  /** The ops applied to get from the old world to the new one. */
  patch: Patch;
  label: string;
}

/** Undoes the last step, or returns `null` if there is none. */
export function undo(world: World, h: History): Result<Step> | null {
  const entry = h.past[h.past.length - 1];
  if (!entry) return null;
  const r = applyChecked(world, entry.inverse);
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      world: r.value.world,
      history: { ...h, past: h.past.slice(0, -1), future: [...h.future, entry] },
      patch: entry.inverse,
      label: entry.label,
    },
  };
}

/** Redoes the last undone step, or returns `null` if there is none. */
export function redo(world: World, h: History): Result<Step> | null {
  const entry = h.future[h.future.length - 1];
  if (!entry) return null;
  const r = applyChecked(world, entry.patch);
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      world: r.value.world,
      history: { ...h, past: [...h.past, entry], future: h.future.slice(0, -1) },
      patch: entry.patch,
      label: entry.label,
    },
  };
}
