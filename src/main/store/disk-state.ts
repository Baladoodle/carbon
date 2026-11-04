/**
 * What carbon knows about the files of each open world directory, for the file
 * watcher (watcher.ts) and the read-only guard:
 *
 * - `known`: the content carbon last read or wrote, per path. A file on disk
 *   that differs from it was changed outside carbon.
 * - `base` and `lastWrite`: carbon's own writes count as *unsaved* to the
 *   outside for a settle window (`settleMs`) after they land: an editor or
 *   agent writing the same file inside that window can't have seen them. `base`
 *   is the content from before the window's first write, the common ancestor
 *   for a three-way merge.
 * - `readOnly`: why writes are refused (a world from a newer carbon).
 */
export interface DiskState {
  /** What the last open did beyond reading (for the store's notices). */
  lastLoad?: {
    migrated?: { from: number; to: number; backup: string };
    quarantined: string[];
    cleaned: string[];
  };
  known: Map<string, string>;
  base: Map<string, string | null>;
  lastWrite: Map<string, number>;
  settleMs: number;
  readOnly: string | null;
  now: () => number;
}

const states = new Map<string, DiskState>();

export const DEFAULT_SETTLE_MS = 15_000;

export function diskState(dir: string): DiskState {
  let s = states.get(dir);
  if (!s) {
    s = {
      known: new Map(),
      base: new Map(),
      lastWrite: new Map(),
      settleMs: DEFAULT_SETTLE_MS,
      readOnly: null,
      now: () => Date.now(),
    };
    states.set(dir, s);
  }
  return s;
}

/** Forgets a directory (tests, or reopening a world). */
export const resetDiskState = (dir: string): void => void states.delete(dir);

/** Records that carbon read these files: they are what the outside has too. */
export function noteRead(s: DiskState, files: ReadonlyMap<string, string>, replace = true): void {
  if (replace) {
    s.known.clear();
    s.base.clear();
    s.lastWrite.clear();
  }
  for (const [p, c] of files) s.known.set(p, c);
}

/** Records one of carbon's own writes (`null`: a removal). */
export function noteWrite(s: DiskState, rel: string, content: string | null): void {
  const t = s.now();
  if (!inWindow(s, rel, t)) s.base.set(rel, s.known.get(rel) ?? null);
  if (content === null) s.known.delete(rel);
  else s.known.set(rel, content);
  s.lastWrite.set(rel, t);
}

/** Records content that carbon accepted from outside (no window: it is settled). */
export function noteAccepted(s: DiskState, rel: string, content: string | null): void {
  if (content === null) s.known.delete(rel);
  else s.known.set(rel, content);
  s.base.delete(rel);
  s.lastWrite.delete(rel);
}

/** Whether carbon wrote this path within the settle window. */
export function inWindow(s: DiskState, rel: string, t = s.now()): boolean {
  const w = s.lastWrite.get(rel);
  return w !== undefined && t - w < s.settleMs;
}
