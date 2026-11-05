import { critiqueInputsHash, critiqueNoteEntity } from '../bench/critique';
import { getEntity, type World } from '../model/world';
import { checkNoteSubjects } from './checks';

/**
 * Persisted note dismissals and when they are pruned (decided by qa-core; see
 * docs/build-notes/qa-core.md §5).
 *
 * A dismissal is `note id → inputs hash`, and holds while the note says the
 * same thing. Some can never match a note again, and only take room (the file
 * keeps at most 5,000, oldest dropped first, live ones included):
 *
 * - a check note naming an entity that is gone: any later entity with that id
 *   is new, and the runner folds its `created` stamp into the hash
 * - a critique note (`ai:<entity>:…`) whose entity is gone, or has changed
 *   since: its hash is the whole entity as it was
 *
 * Such a dismissal is *dead*. It is pruned once it has been dead for
 * `DISMISSAL_GRACE_DAYS` (checked on every open), not at once: a world can
 * come back as it was (a git checkout of yesterday, a branch switched back),
 * and then its dismissals hold again. A dismissal that comes alive again
 * forgets its date. Anything else (an unknown id format) is kept.
 */
export const DISMISSAL_GRACE_DAYS = 30;

export interface DismissalFile {
  /** Note id → the inputs hash it was dismissed for. */
  notes: Record<string, string>;
  /** Dead dismissals → when they were first seen dead (ISO). */
  dead: Record<string, string>;
}

/** Whether a dismissal can never match a note again in this world. */
export function isDeadDismissal(world: World, id: string, hash: string): boolean {
  if (id.startsWith('ai:')) {
    const entity = critiqueNoteEntity(id);
    if (!entity) return false;
    const e = getEntity(world, entity);
    return !e || critiqueInputsHash(e) !== hash;
  }
  if (id.startsWith('check:'))
    return checkNoteSubjects(id).some((subject) => !getEntity(world, subject));
  return false;
}

const DAY_MS = 86_400_000;

/**
 * One open's pruning, pure: marks newly dead dismissals with `now`, forgets
 * the date of those alive again, and drops those dead for the grace period.
 */
export function pruneDismissals(
  file: DismissalFile,
  world: World,
  now: string,
  graceDays = DISMISSAL_GRACE_DAYS,
): { file: DismissalFile; pruned: string[]; changed: boolean } {
  const notes: Record<string, string> = {};
  const dead: Record<string, string> = {};
  const pruned: string[] = [];
  const t = Date.parse(now);
  for (const [id, hash] of Object.entries(file.notes)) {
    if (!isDeadDismissal(world, id, hash)) {
      notes[id] = hash;
      continue;
    }
    const since = file.dead[id] ?? now;
    const age = t - Date.parse(since);
    if (Number.isFinite(age) && age >= graceDays * DAY_MS) {
      pruned.push(id);
      continue;
    }
    notes[id] = hash;
    dead[id] = Number.isFinite(age) ? since : now;
  }
  const changed =
    pruned.length > 0 ||
    Object.keys(dead).length !== Object.keys(file.dead).length ||
    Object.entries(dead).some(([id, d]) => file.dead[id] !== d);
  return { file: { notes, dead }, pruned, changed };
}
