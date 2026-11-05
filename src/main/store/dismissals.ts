import { pruneDismissals } from '@core/checks/dismissals';
import type { World } from '@core/model/world';
import { DismissalsSchema } from '@shared/ipc';
import { META, readJson, writeJson } from './meta';

/**
 * Dismissed notes, per world: `.carbon/dismissals.json`, note id → the inputs
 * hash it was dismissed for. The renderer hides a note while its current hash
 * matches; when its inputs change the hash differs and it shows again (and the
 * stale entry is dropped). Writes are serialised and atomic.
 *
 * On open, dismissals that can never match again (their note's entity is gone,
 * or a critique's entity has changed) are marked with the date, and pruned
 * after a grace period (`pruneDismissals`, src/core/checks/dismissals.ts). The
 * file keeps `notes` as before, plus `dead` (id → first seen dead); a carbon
 * that doesn't know `dead` reads `notes` alone.
 */
const MAX_ENTRIES = 5000;

export class Dismissals {
  private map: Record<string, string> | null = null;
  private dead: Record<string, string> = {};
  private queue: Promise<void> = Promise.resolve();
  private pruning: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private async load(): Promise<Record<string, string>> {
    if (!this.map) {
      const raw = await readJson(this.dir, META.dismissals);
      const r = DismissalsSchema.safeParse(
        raw && typeof raw === 'object' && 'notes' in raw ? raw.notes : raw,
      );
      this.map = r.success ? r.data : {};
      const dead = DismissalsSchema.safeParse(
        raw && typeof raw === 'object' && 'dead' in raw ? raw.dead : {},
      );
      this.dead = dead.success
        ? Object.fromEntries(Object.entries(dead.data).filter(([id]) => id in (this.map ?? {})))
        : {};
    }
    return this.map;
  }

  async all(): Promise<Record<string, string>> {
    await this.pruning;
    return { ...(await this.load()) };
  }

  /**
   * Marks dead dismissals and drops those dead for the grace period (once per
   * open, before the renderer reads them). Returns the pruned ids.
   */
  prune(world: World, now: string): Promise<string[]> {
    const run = this.pruning.then(async () => {
      const notes = await this.load();
      const r = pruneDismissals({ notes, dead: this.dead }, world, now);
      if (!r.changed) return [];
      this.map = r.file.notes;
      this.dead = r.file.dead;
      await this.save();
      return r.pruned;
    });
    this.pruning = run.catch(() => undefined);
    return run;
  }

  /** Sets (or with `null`, clears) one dismissal. */
  async set(id: string, hash: string | null): Promise<void> {
    await this.pruning;
    const map = { ...(await this.load()) };
    if (hash === null) {
      if (!(id in map)) return;
      delete map[id];
    } else {
      if (map[id] === hash) return;
      delete map[id]; // re-insert at the end: newest last, oldest dropped first
      map[id] = hash;
    }
    // A dismissal set again is alive: it forgets when it was dead.
    const { [id]: _, ...dead } = this.dead;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
      delete map[k];
      delete dead[k];
    }
    this.map = map;
    this.dead = dead;
    await this.save();
  }

  private save(): Promise<void> {
    // `dead` only when there is any: otherwise the file is exactly the old format.
    const snapshot = {
      version: 1,
      notes: this.map ?? {},
      ...(Object.keys(this.dead).length > 0 ? { dead: this.dead } : {}),
    };
    // One failed write (a full disk) reports to its caller but doesn't stop
    // the queue: the next save writes the whole map, this entry included.
    const run = this.queue.then(() => writeJson(this.dir, META.dismissals, snapshot));
    this.queue = run.catch(() => undefined);
    return run;
  }
}
