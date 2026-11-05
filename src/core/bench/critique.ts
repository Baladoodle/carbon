import type { CritiqueNote } from '../ai/moments';
import type { Entity } from '../model/entity';
import type { Note } from '../model/notes';
import { getEntity, type World } from '../model/world';
import { hashValue } from '../util/hash';

/**
 * Critique results → notes for the margin and the Bench, pure. Published under
 * `ai:<entityId>` (foundation §1.5), so a new critique of the same entity
 * replaces the old notes. Ids are stable for the same note on the same
 * entity, so a dismissal holds until the critique says something new.
 */
export const critiqueSource = (entityId: string): string => `ai:${entityId}`;

/**
 * The critique sources (of those published) whose entity no longer exists:
 * their notes would otherwise outlive the entity, in the margin's store and
 * in the status line's count.
 */
export function staleCritiqueSources(sources: Iterable<string>, world: World): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (!s.startsWith('ai:')) continue;
    const id = s.slice(3);
    if (id !== '' && !getEntity(world, id)) out.push(s);
  }
  return out;
}

/** The entity a critique note is about, read back from its id (`ai:<entity>:<kind>:<hash>`). */
export function critiqueNoteEntity(noteId: string): string | null {
  const m = /^ai:([a-z0-9-]+):/.exec(noteId);
  return m?.[1] ?? null;
}

/** The inputs hash of a critique note about `entity`: the whole entity, as it was. */
export const critiqueInputsHash = (entity: Entity | null): string => hashValue(entity);

export function critiqueNotes(
  world: World,
  entityId: string,
  notes: readonly CritiqueNote[],
): Note[] {
  const e = getEntity(world, entityId);
  const inputsHash = critiqueInputsHash(e ?? null);
  const seen = new Set<string>();
  const out: Note[] = [];
  for (const n of notes) {
    // Only notes about entities that exist (the gateway checks too; this keeps the margin honest).
    const others = n.entities.filter((id) => id !== entityId && getEntity(world, id) !== undefined);
    const id = `ai:${entityId}:${n.kind}:${hashValue([n.text, n.field ?? '', n.ruleId ?? '']).slice(0, 10)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      source: 'ai',
      kind: n.kind,
      severity: 'warn',
      text: n.text,
      entities: [entityId, ...others],
      inputsHash,
    });
  }
  return out;
}
