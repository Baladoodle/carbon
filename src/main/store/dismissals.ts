import { DismissalsSchema } from '@shared/ipc';
import { META, readJson, writeJson } from './meta';

/**
 * Dismissed notes, per world: `.carbon/dismissals.json`, note id → the inputs
 * hash it was dismissed for. The renderer hides a note while its current hash
 * matches; when its inputs change the hash differs and it shows again (and the
 * stale entry is dropped). Writes are serialised and atomic.
 */
const MAX_ENTRIES = 5000;

export class Dismissals {
  private map: Record<string, string> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async all(): Promise<Record<string, string>> {
    if (!this.map) {
      const raw = await readJson(this.dir, META.dismissals);
      const r = DismissalsSchema.safeParse(
        raw && typeof raw === 'object' && 'notes' in raw ? raw.notes : raw,
      );
      this.map = r.success ? r.data : {};
    }
    return { ...this.map };
  }

  /** Sets (or with `null`, clears) one dismissal. */
  async set(id: string, hash: string | null): Promise<void> {
    const map = { ...(await this.all()) };
    if (hash === null) {
      if (!(id in map)) return;
      delete map[id];
    } else {
      if (map[id] === hash) return;
      delete map[id]; // re-insert at the end: newest last, oldest dropped first
      map[id] = hash;
    }
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[k];
    this.map = map;
    const snapshot = { version: 1, notes: map };
    this.queue = this.queue.then(() => writeJson(this.dir, META.dismissals, snapshot));
    await this.queue;
  }
}
