import { cmd } from '@core/commands/registry';
import { fieldValue } from '@core/model/lifecycle';
import { getEntity } from '@core/model/world';
import { hashValue } from '@core/util/hash';
import { ai } from '../ai/client';
import { publishNotes } from '../state/notes';
import { flash } from '../state/ui';
import { currentWorld, transact } from '../state/world';
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

/** Commits in flight per entity, so a critique on leaving sees your last edit. */
const inflight = new Map<string, Promise<unknown>>();

export const settled = (entityId: string): Promise<unknown> =>
  inflight.get(entityId) ?? Promise.resolve();

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
  benchAi.markEdited(entityId);
  // What you type replaces what the AI proposed for the field.
  setEntry('pending', fieldId(entityId, key), undefined);
  const p = transact(`Edit ${key} of ${e.name}`, [
    cmd('entity.setField', { id: entityId, field: key, value, source: 'user' }),
  ]);
  inflight.set(entityId, p);
  const r = await p;
  if (inflight.get(entityId) === p) inflight.delete(entityId);
  return r.ok ? null : r.error.message;
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
  benchAi.markEdited(entityId);
  const p = transact(`Set ${key} of ${e.name}`, [
    cmd('entity.setAttribute', { id: entityId, key, value, source: 'user' }),
  ]);
  inflight.set(entityId, p);
  const r = await p;
  if (inflight.get(entityId) === p) inflight.delete(entityId);
  return r.ok ? null : r.error.message;
}

/** You left an entity: once your last edit has landed, critique it if you changed it. */
export function leaveEntity(entityId: string): void {
  void settled(entityId).then(() => benchAi.left(entityId));
}
