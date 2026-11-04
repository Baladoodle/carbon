import { applyPatch } from '@core/commands/patch';
import type { Command } from '@core/commands/registry';
import type { Entity } from '@core/model/entity';
import { getEntity, type World } from '@core/model/world';
import type { DispatchResult, HistoryInfo, WorldSnapshot } from '@shared/ipc';
import { invoke, on } from '../bridge';
import { createStore, shallowEqual, useStore } from './store';

/**
 * The renderer's mirror of the world: one snapshot, then patches in `rev`
 * order. It never changes the world itself: changes go to the main process as
 * commands, and come back as patches.
 */
export interface WorldState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  rev: number;
  dir: string;
  world: World | null;
  issues: WorldSnapshot['issues'];
  history: HistoryInfo;
}

export const worldStore = createStore<WorldState>({
  status: 'loading',
  rev: 0,
  dir: '',
  world: null,
  issues: [],
  history: { canUndo: false, canRedo: false },
});

const fromSnapshot = (s: WorldSnapshot): WorldState => ({
  status: 'ready',
  rev: s.rev,
  dir: s.dir,
  world: s.world,
  issues: s.issues,
  history: s.history,
});

let started = false;

/** Loads the snapshot and follows patches. Called once by the shell. */
export async function startWorldSync(): Promise<void> {
  if (started) return;
  started = true;
  let resyncing = false;
  const resync = async (): Promise<void> => {
    if (resyncing) return;
    resyncing = true;
    try {
      worldStore.set(fromSnapshot(await invoke('world:snapshot', null)));
    } finally {
      resyncing = false;
    }
  };
  on('world:patch', (e) => {
    const s = worldStore.get();
    if (!s.world || resyncing) return;
    if (e.rev <= s.rev) return; // already have it
    if (e.rev !== s.rev + 1) {
      void resync(); // a gap: start again from a snapshot
      return;
    }
    try {
      worldStore.set({ ...s, rev: e.rev, world: applyPatch(s.world, e.patch), history: e.history });
    } catch {
      void resync();
    }
  });
  on('world:reset', (snap) => worldStore.set(fromSnapshot(snap)));
  try {
    await resync();
  } catch (e) {
    worldStore.set((s) => ({
      ...s,
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    }));
  }
}

/** Sends commands to the main process; several form one undo step. */
export function dispatch(...commands: Command[]): Promise<DispatchResult> {
  return invoke('world:dispatch', { commands });
}

/** Like `dispatch`, with an explicit undo label (e.g. "Merge 3 candidates"). */
export function transact(label: string, commands: Command[]): Promise<DispatchResult> {
  return invoke('world:dispatch', { commands, label });
}

export const undo = (): ReturnType<typeof invoke<'world:undo'>> => invoke('world:undo', null);
export const redo = (): ReturnType<typeof invoke<'world:redo'>> => invoke('world:redo', null);

const EMPTY: World | null = null;

/** Selects from the world; re-renders only when the selected value changes. */
export function useWorld<T>(
  selector: (world: World) => T,
  equal: (a: T, b: T) => boolean = shallowEqual,
): T | undefined {
  return useStore(
    worldStore,
    (s) => (s.world ? selector(s.world) : undefined),
    (a, b) => (a === undefined || b === undefined ? a === b : equal(a, b)),
  );
}

/** One entity by id (re-renders only when that entity changes). */
export function useEntity(id: string | null | undefined): Entity | undefined {
  return useStore(worldStore, (s) => (s.world && id ? getEntity(s.world, id) : undefined));
}

/** Load status, revision, directory, load issues and undo/redo info. */
export function useWorldMeta(): Omit<WorldState, 'world'> {
  return useStore(
    worldStore,
    (s) => ({
      status: s.status,
      rev: s.rev,
      dir: s.dir,
      issues: s.issues,
      history: s.history,
      ...(s.error ? { error: s.error } : {}),
    }),
    shallowEqual,
  );
}

/** The current world, or null while loading (for event handlers, not render). */
export const currentWorld = (): World | null => worldStore.get().world ?? EMPTY;
