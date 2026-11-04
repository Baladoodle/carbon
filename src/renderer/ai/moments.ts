import type { AiOutcome } from '@core/ai/gateway';
import type { CritiqueNote, Moment, MomentRequest } from '@core/ai/moments';
import type { EntityId } from '@core/model/ids';
import type { Note } from '@core/model/notes';
import { publishNotes } from '../state/notes';
import { ai } from './client';

/**
 * The AI moments for UIs (W1's Bench, W6's Export) with the rules of
 * EXPERIENCE §5 built in: one request at a time per entity (a new trigger
 * aborts the stale one here too, so the UI never shows a stale answer) and
 * critique notes published as `ai:<entityId>` for the Column margin, the
 * Bench and the status line.
 *
 *   const out = await suggest(id, 'tradeoff', shown);         // tab
 *   const out = await suggestThree(id, 'tradeoff');           // shift+tab
 *   const out = await fill(id);                               // ctrl+enter
 *   await critique(id, 'finish_edit');                        // publishes notes
 */

const inflight = new Map<string, AbortController>();

function exclusive<M extends Moment>(
  key: string,
  moment: M,
  request: MomentRequest<M>,
): Promise<AiOutcome<M>> {
  inflight.get(key)?.abort();
  const ac = new AbortController();
  inflight.set(key, ac);
  return ai.run(moment, request, { signal: ac.signal }).finally(() => {
    if (inflight.get(key) === ac) inflight.delete(key);
  });
}

/** Cancels whatever is in flight for an entity (e.g. when the Bench closes). */
export function cancelFor(entityId: EntityId): void {
  inflight.get(entityId)?.abort();
}

export const suggest = (
  entityId: EntityId,
  field: string,
  avoid: unknown[] = [],
): Promise<AiOutcome<'suggest_one'>> =>
  exclusive(entityId, 'suggest_one', { entityId, field, avoid });

export const suggestThree = (
  entityId: EntityId,
  field: string,
  avoid: unknown[] = [],
): Promise<AiOutcome<'suggest_three'>> =>
  exclusive(entityId, 'suggest_three', { entityId, field, avoid });

export const fill = (entityId: EntityId): Promise<AiOutcome<'fill_entity'>> =>
  exclusive(entityId, 'fill_entity', { entityId });

/** Critique notes as margin notes. Ids are stable per entity, kind and text. */
export function critiqueNotes(
  entityId: EntityId,
  notes: CritiqueNote[],
  inputsHash: string,
): Note[] {
  return notes.map((n) => ({
    id: `ai:${entityId}:${n.kind}:${n.field ?? ''}:${n.entities.join(',')}`,
    source: 'ai',
    kind: n.kind,
    severity: 'warn',
    text: n.text,
    entities: [entityId, ...n.entities.filter((e) => e !== entityId)],
    inputsHash,
  }));
}

/**
 * Critiques an entity and publishes its notes (replacing earlier ones for
 * it). A cancelled or failed critique leaves the previous notes in place.
 */
export async function critique(
  entityId: EntityId,
  trigger: 'finish_edit' | 'state_change' | 'on_demand',
): Promise<AiOutcome<'critique'>> {
  const out = await exclusive(entityId, 'critique', { entityId, trigger });
  if (out.ok)
    publishNotes(`ai:${entityId}`, critiqueNotes(entityId, out.result.notes, out.meta.requestHash));
  return out;
}
