import { watch, type FSWatcher } from 'node:fs';
import { worldToFiles, type FileMap, type LoadIssue } from '@core/files/world-files';
import { hashString } from '@core/util/hash';
import type { World } from '@core/model/world';
import { applyFileChanges } from './apply-files';
import { diskState, inWindow, noteAccepted } from './disk-state';
import { mergeFile, type FieldConflict } from './merge';
import { readWorldFiles, writeChanges } from './world-dir';

/**
 * The file watcher (docs/SYSTEM.md §4): picks up edits made outside carbon (by
 * hand, by Claude Code, by a git checkout) and feeds them through
 * `session.applyExternal`.
 *
 * - carbon's own writes are recognised (disk-state.ts) and ignored
 * - an external edit to a file carbon hasn't touched recently is taken as is
 * - an external edit to a file carbon wrote within the settle window is merged
 *   three ways (merge.ts); fields both sides changed differently become a
 *   conflict that the user settles in a dialog (keep carbon's or the file's)
 * - an invalid external file is not applied: carbon keeps its version in
 *   memory and reports the file (it is quarantined on the next open if it's
 *   still broken)
 *
 * `fs.watch` (recursive, inotify on Linux) is the trigger; if it can't start,
 * the watcher polls instead. Every trigger ends in the same `scan()`.
 */
export interface WatchedSession {
  readonly world: World;
  flush(): Promise<void>;
  applyExternal(next: World, issues?: LoadIssue[]): void;
}

export interface Conflict {
  id: string;
  path: string;
  /** The entity's id and name, when the file is an entity. */
  entity?: { id: string; name: string; kind: string };
  fields: FieldConflict[];
}

interface Pending extends Conflict {
  ifOurs: string | null;
  ifTheirs: string | null;
}

export interface WatcherOptions {
  debounceMs?: number;
  /** Poll interval when fs.watch is unavailable (or always, when `forcePoll`). */
  pollMs?: number;
  forcePoll?: boolean;
  /** Load issues that should keep showing (quarantined files). */
  baseIssues?: () => LoadIssue[];
  onConflicts?: (conflicts: Conflict[]) => void;
  onError?: (e: unknown) => void;
}

/** Paths the watcher never reacts to. */
export function ignoredPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  const top = parts[0] ?? '';
  const name = parts[parts.length - 1] ?? '';
  return (
    top === '.git' ||
    top === '.carbon' ||
    top === 'exports' ||
    top === 'ai-log' ||
    name.endsWith('.tmp') ||
    name.endsWith('~') ||
    name.endsWith('.swp') ||
    name.startsWith('.#') ||
    name === '4913' // vim's write-test file
  );
}

export class WorldWatcher {
  private fsw: FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly pending = new Map<string, Pending>();
  /** Invalid external content we've already reported, by path (so it isn't re-reported every scan). */
  private readonly rejected = new Map<string, string>();
  private externalIssues: LoadIssue[] = [];

  constructor(
    readonly dir: string,
    private readonly session: WatchedSession,
    private readonly opts: WatcherOptions = {},
  ) {}

  start(): void {
    if (!this.opts.forcePoll) {
      try {
        this.fsw = watch(this.dir, { recursive: true, persistent: false }, (_ev, file) => {
          if (file && ignoredPath(file)) return;
          this.schedule();
        });
        this.fsw.on('error', (e) => {
          this.opts.onError?.(e);
          this.fallBackToPolling();
        });
        return;
      } catch (e) {
        this.opts.onError?.(e);
      }
    }
    this.fallBackToPolling();
  }

  private fallBackToPolling(): void {
    this.fsw?.close();
    this.fsw = null;
    if (this.poll || this.stopped) return;
    this.poll = setInterval(() => this.schedule(0), this.opts.pollMs ?? 2000);
  }

  stop(): void {
    this.stopped = true;
    this.fsw?.close();
    this.fsw = null;
    if (this.poll) clearInterval(this.poll);
    if (this.timer) clearTimeout(this.timer);
  }

  /** Conflicts waiting for the user. */
  conflicts(): Conflict[] {
    return [...this.pending.values()].map(({ ifOurs: _o, ifTheirs: _t, ...c }) => c);
  }

  /** Issues from external edits that couldn't be applied. */
  issues(): LoadIssue[] {
    return this.externalIssues;
  }

  private schedule(delay = this.opts.debounceMs ?? 150): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scan().catch((e: unknown) => this.opts.onError?.(e));
    }, delay);
  }

  /** Compares the disk with what carbon knows, and applies what changed. Serialised. */
  scan(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.scanOnce();
        // scanOnce sets `again` when a save raced the read (TS can't see that through the await).
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async scanOnce(): Promise<void> {
    const disk = diskState(this.dir);
    await this.session.flush();
    const files = await readWorldFiles(this.dir);
    // A save that started while we read: read again once it's done.
    const settled = await this.session.flush().then(() => readWorldFiles(this.dir));
    if (!sameFiles(files, settled)) {
      this.again = true;
      return;
    }
    const changed = new Map<string, string | null>();
    for (const [p, c] of files) if (disk.known.get(p) !== c) changed.set(p, c);
    for (const p of disk.known.keys()) if (!files.has(p)) changed.set(p, null);
    for (const [p, c] of [...changed]) {
      if (this.rejected.has(p) && this.rejected.get(p) === c) changed.delete(p);
    }
    if (changed.size === 0) return;

    const world = this.session.world;
    const ours = worldToFiles(world);
    const merged = new Map<string, string | null>();
    const writeBack = new Map<string, string>();
    const removeBack: string[] = [];
    for (const [p, theirs] of changed) {
      const mine = ours.get(p) ?? null;
      const base = inWindow(disk, p) ? (disk.base.get(p) ?? null) : mine;
      const r = mergeFile(base, mine, theirs, p.startsWith('entities/'));
      if (r.kind === 'take') {
        merged.set(p, r.content);
        if (r.content !== theirs) {
          if (r.content === null) removeBack.push(p);
          else writeBack.set(p, r.content);
        }
        this.pending.delete(p);
      } else {
        // Provisionally keep carbon's values for the conflicting keys until the user decides.
        merged.set(p, r.ifOurs);
        const id = `conflict:${hashString(`${p}\n${theirs ?? ''}`)}`;
        const e = r.ifOurs ? world.entities[entityIdOf(p) ?? ''] : undefined;
        this.pending.set(p, {
          id,
          path: p,
          ...(e ? { entity: { id: e.id, name: e.name, kind: e.kind } } : {}),
          fields: r.conflicts,
          ifOurs: r.ifOurs,
          ifTheirs: r.ifTheirs,
        });
      }
      noteAccepted(disk, p, theirs);
    }
    this.apply(world, merged);
    // Write back what the merge kept from carbon, so the disk matches the world.
    const pendingPaths = new Set(this.pending.keys());
    const write = new Map([...writeBack].filter(([p]) => !pendingPaths.has(p)));
    const remove = removeBack.filter((p) => !pendingPaths.has(p));
    if (write.size > 0 || remove.length > 0) {
      try {
        await writeChanges(this.dir, { write, remove });
      } catch (e) {
        this.opts.onError?.(e); // e.g. a read-only world: the world is right, the disk catches up later
      }
    }
    if (this.pending.size > 0) this.opts.onConflicts?.(this.conflicts());
  }

  private apply(world: World, changes: Map<string, string | null>): void {
    const r = applyFileChanges(world, changes);
    // Invalid files: keep carbon's version and say so.
    const issueAt = new Map(r.issues.map((i) => [i.path, i]));
    for (const [p, c] of changes) {
      if (issueAt.has(p)) this.rejected.set(p, c ?? '');
      else this.rejected.delete(p);
    }
    this.externalIssues = [
      ...this.externalIssues.filter((i) => !changes.has(i.path)),
      ...r.issues.map((i) => ({
        ...i,
        message: `${i.message} (changed outside carbon; carbon kept its version)`,
      })),
    ];
    this.session.applyExternal(r.world, [
      ...(this.opts.baseIssues?.() ?? []),
      ...this.externalIssues,
    ]);
  }

  /** Settles one conflict: `ours` keeps carbon's values, `theirs` the file's. */
  async resolve(id: string, keep: 'ours' | 'theirs'): Promise<boolean> {
    const entry = [...this.pending.values()].find((c) => c.id === id);
    if (!entry) return false;
    this.pending.delete(entry.path);
    const content = keep === 'ours' ? entry.ifOurs : entry.ifTheirs;
    if (content === null) await writeChanges(this.dir, { write: new Map(), remove: [entry.path] });
    else await writeChanges(this.dir, { write: new Map([[entry.path, content]]), remove: [] });
    // The user chose: this content is settled, not a fresh in-app edit.
    noteAccepted(diskState(this.dir), entry.path, content);
    this.apply(this.session.world, new Map([[entry.path, content]]));
    return true;
  }
}

const entityIdOf = (p: string): string | undefined =>
  /^entities\/[a-z]+\/([^/]+)\.md$/.exec(p)?.[1];

function sameFiles(a: FileMap, b: FileMap): boolean {
  if (a.size !== b.size) return false;
  for (const [p, c] of a) if (b.get(p) !== c) return false;
  return true;
}
