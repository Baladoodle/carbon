import { cmd } from '@core/commands/registry';
import { fieldValue } from '@core/model/lifecycle';
import type { EntityKind } from '@core/model/kinds';
import { getEntity, schemaOf } from '@core/model/world';
import { defOf } from '@core/bench/value';
import { hashValue } from '@core/util/hash';
import { ai } from '../ai/client';
import { notesStore, publishNotes } from '../state/notes';
import { flash } from '../state/ui';
import { currentWorld, transact, whenRev, worldStore } from '../state/world';
import { staleCritiqueSources } from '@core/bench/critique';
import { createBenchAi } from './ai';
import { fieldId, setEntry } from './store';

/**
 * The Bench's wiring to the app: its AI controller (through the renderer's
 * `ai` client) and committing field edits as commands. One instance.
 */
export const benchAi = createBenchAi({
  gateway: ai,
  getWorld: currentWorld,
  dispatch: (label, commands) => transact(label, commands),
  publishNotes,
  say: (text, tone) => flash(text, tone),
});

/**
 * Critique notes leave with their entity: when an entity is deleted (from the
 * Bench, the Codex, an undo, an outside edit), its `ai:<id>` notes are
 * withdrawn, and a critique still in flight for it is cancelled.
 */
let lastEntities: unknown = null;
worldStore.subscribe(() => {
  const w = worldStore.get().world;
  if (!w || w.entities === lastEntities) return;
  lastEntities = w.entities;
  for (const source of staleCritiqueSources(Object.keys(notesStore.get().bySource), w)) {
    if ((notesStore.get().bySource[source]?.length ?? 0) > 0) publishNotes(source, []);
    benchAi.cancel(source.slice(3));
  }
});

/** Commits in flight per entity, so a critique on finishing (ai/triggers.ts) sees your last edit. */
const inflight = new Map<string, Promise<unknown>>();

export const settled = (entityId: string): Promise<unknown> =>
  inflight.get(entityId) ?? Promise.resolve();

/** A commit's result, once its patch is also in the renderer's mirror (not only answered). */
const landedIn = <R extends { ok: boolean; rev?: number }>(p: Promise<R>): Promise<R> =>
  p.then((r) => (r.ok && typeof r.rev === 'number' ? whenRev(r.rev).then(() => r) : r));

/**
 * Writes a field you edited (`null` clears it). Does nothing when the value is
 * unchanged. Returns the error message, if the command refused it.
 */
export async function commitField(
  entityId: string,
  key: string,
  value: unknown,
): Promise<string | null> {
  const w = currentWorld();
  const e = w ? getEntity(w, entityId) : undefined;
  if (!e) return 'That entity no longer exists';
  const current = fieldValue(e, key);
  const same =
    hashValue(current ?? null) === hashValue(value ?? null) ||
    (value === null && (current === '' || (Array.isArray(current) && current.length === 0)));
  if (same) return null;
  // What you type replaces what the AI proposed for the field.
  setEntry('pending', fieldId(entityId, key), undefined);
  const p = transact(`Edit ${fieldWord(key, e.kind)} of ${e.name}`, [
    cmd('entity.setField', { id: entityId, field: key, value, source: 'user' }),
  ]);
  const landed = landedIn(p);
  inflight.set(entityId, landed);
  const r = await landed;
  if (inflight.get(entityId) === landed) inflight.delete(entityId);
  return r.ok ? null : r.error.message;
}

/** A field as the undo label names it: its label ("bottom"), not its key ("y_bottom"). */
function fieldWord(key: string, kind: EntityKind): string {
  const w = currentWorld();
  const def = w ? defOf(schemaOf(w).kinds[kind], key) : undefined;
  return def ? def.label.toLowerCase() : key;
}

/** Writes an attribute (`null` removes it). */
export async function commitAttribute(
  entityId: string,
  key: string,
  value: number | null,
): Promise<string | null> {
  const w = currentWorld();
  const e = w ? getEntity(w, entityId) : undefined;
  if (!e) return 'That entity no longer exists';
  if ((e.attributes[key] ?? null) === value) return null;
  const label = schemaOf(w!).kinds[e.kind].attributes.find((a) => a.key === key)?.label;
  const p = transact(`Set ${label ? label.toLowerCase() : key} of ${e.name}`, [
    cmd('entity.setAttribute', { id: entityId, key, value, source: 'user' }),
  ]);
  const landed = landedIn(p);
  inflight.set(entityId, landed);
  const r = await landed;
  if (inflight.get(entityId) === landed) inflight.delete(entityId);
  return r.ok ? null : r.error.message;
}
