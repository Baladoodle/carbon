import type { Note } from '@core/model/notes';
import { createStore, useStore } from './store';

/**
 * Notes in the margin, grouped by producer. Mechanical checks (W6) publish
 * under `checks`; AI critique (W4) under `ai:<entityId>`. Readers (Column
 * margin, Bench, status line) see the union, minus dismissed ids.
 */
export interface NotesState {
  bySource: Record<string, Note[]>;
  dismissed: Record<string, true>;
}

export const notesStore = createStore<NotesState>({ bySource: {}, dismissed: {} });

/** Replaces the notes from one producer. */
export const publishNotes = (source: string, notes: Note[]): void =>
  notesStore.set((s) => ({ ...s, bySource: { ...s.bySource, [source]: notes } }));

export const dismissNote = (id: string): void =>
  notesStore.set((s) => ({ ...s, dismissed: { ...s.dismissed, [id]: true } }));

const all = (s: NotesState): Note[] =>
  Object.values(s.bySource)
    .flat()
    .filter((n) => !s.dismissed[n.id]);

/** Every open note, or those about one entity. */
export function useNotes(entityId?: string): Note[] {
  return useStore(
    notesStore,
    (s) => (entityId ? all(s).filter((n) => n.entities.includes(entityId)) : all(s)),
    (a, b) => a.length === b.length && a.every((n, i) => n === b[i]),
  );
}
