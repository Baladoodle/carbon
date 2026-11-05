import type { Patch } from '@core/commands/patch';
import type { World } from '@core/model/world';
import type { EventPayload } from '@shared/ipc';
import { on } from '../bridge';
import { useStore } from '../state/store';
import { worldStore, type WorldState } from '../state/world';

/**
 * The status line's entity count, kept from patches instead of counting the
 * entities table on every world change (`Object.keys` on 2,000 entities was
 * about 1.2 ms per command, the largest item in a rename's renderer profile).
 *
 * A patch changes the count only by ops at `entities/<id>`: a set of an id
 * that wasn't there adds one, a remove of one that was takes one away. The
 * counter records each `world:patch` by rev, and when the mirror's world
 * moves from the rev it last counted to a later one, it applies the deltas of
 * the patches in between: O(patch), not O(entities). Whenever it can't prove
 * the delta (a gap in the patches it saw, a reset, a world that was loaded
 * rather than patched, a patch that replaces the whole table) it counts afresh, so it is never wrong, only
 * occasionally O(n). A property test (StatusLine.count.test.ts) checks it
 * always equals the true count.
 */

type Entities = World['entities'];

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The entity count after `patches`, applied in order to a world whose table is
 * `entities` (holding `count` entities). `null` when a patch replaces the
 * table or the world as a whole, so the delta isn't known from the ops alone.
 */
export function countAfter(
  entities: Entities,
  count: number,
  patches: readonly Patch[],
): number | null {
  // Membership changed by earlier ops; everything else is read from `entities`.
  const now = new Map<string, boolean>();
  let n = count;
  for (const patch of patches)
    for (const op of patch) {
      if (op.path[0] !== 'entities') continue;
      if (op.path.length === 1) return null; // the whole table
      if (op.path.length > 2) continue; // inside one entity
      const id = op.path[1] as string;
      const was = now.get(id) ?? has(entities, id);
      const is = op.op === 'set';
      if (was !== is) n += is ? 1 : -1;
      now.set(id, is);
    }
  return n;
}

/**
 * Whether `next` was reached from `prev` by these patches, not loaded afresh
 * (a snapshot after a gap or a failed patch, which may be another world).
 * Patches share every entity they don't touch; a snapshot from IPC shares
 * none. So one untouched entity, the same object in both, shows it. The
 * entity is one of a few `sentinels` (enumerating the table to find one would
 * cost what the count saves).
 */
function reachedBy(
  prev: Entities,
  next: Entities,
  patches: readonly Patch[],
  sentinels: readonly string[],
): boolean {
  const touched = new Set<string>();
  for (const p of patches)
    for (const op of p)
      if (op.path[0] === 'entities') {
        if (op.path.length === 1) return false;
        touched.add(op.path[1] as string);
      }
  for (const id of sentinels) {
    if (touched.has(id) || !has(prev, id)) continue;
    return has(next, id) && next[id] === prev[id];
  }
  return false; // nothing untouched to compare: count afresh
}

/** How many entities serve as sentinels, chosen on each fresh count. */
const SENTINELS = 8;

/** How many recent patches the counter keeps while waiting for the mirror. */
const KEEP = 256;

export class EntityCounter {
  private last: { rev: number; entities: Entities; count: number } | null = null;
  private sentinels: string[] = [];
  private readonly patches = new Map<number, Patch>();
  /** Full counts so far (the first one, then only after gaps and resets). */
  recounts = 0;

  /** Records a patch event (from `world:patch`). */
  onPatch(rev: number, patch: Patch): void {
    if (this.last && rev <= this.last.rev) return;
    this.patches.set(rev, patch);
    if (this.patches.size > KEEP) {
      // The mirror is far behind or stopped following: count afresh later.
      this.patches.clear();
      this.last = null;
    }
  }

  /** Forgets everything (a `world:reset`: another world, revs start again). */
  onReset(): void {
    this.patches.clear();
    this.last = null;
  }

  /** The number of entities in the mirror's world at revision `rev`. */
  count(rev: number, world: World): number {
    const last = this.last;
    let n: number | null = null;
    if (last && last.entities === world.entities) n = last.count;
    else if (last && rev > last.rev) {
      const between: Patch[] = [];
      for (let r = last.rev + 1; r <= rev; r++) {
        const p = this.patches.get(r);
        if (!p) break;
        between.push(p);
      }
      if (
        between.length === rev - last.rev &&
        reachedBy(last.entities, world.entities, between, this.sentinels)
      )
        n = countAfter(last.entities, last.count, between);
    }
    if (n === null) {
      const keys = Object.keys(world.entities);
      n = keys.length;
      this.recounts++;
      // Spread over the table, so one transaction rarely touches them all.
      const step = Math.max(1, Math.floor(keys.length / SENTINELS));
      this.sentinels = keys.filter((_, i) => i % step === 0).slice(0, SENTINELS);
    }
    this.last = { rev, entities: world.entities, count: n };
    for (const r of this.patches.keys()) if (r <= rev) this.patches.delete(r);
    return n;
  }
}

/**
 * The app's counter. It listens from the moment this module is imported,
 * which the shell does before it starts following the world, so each patch
 * is recorded before the mirror applies it (if one arrives late anyway, the
 * count is taken afresh: still right, just not incremental).
 */
const counter = new EntityCounter();
if (typeof window !== 'undefined' && (window as { carbon?: unknown }).carbon) {
  on('world:patch', (e: EventPayload<'world:patch'>) => counter.onPatch(e.rev, e.patch));
  on('world:reset', () => counter.onReset());
}

/** The count for a state of the mirror, from the app's counter (the hook's selector). */
export const countOf = (s: WorldState): number | undefined =>
  s.world ? counter.count(s.rev, s.world) : undefined;

/** The entity count of the mirror's world (undefined while loading). */
export const useEntityCount = (): number | undefined => useStore(worldStore, countOf);
