import { applyCommands, labelOf } from '@core/commands/apply';
import { diffWorlds } from '@core/commands/diff';
import {
  emptyHistory,
  record,
  redo,
  undo,
  type History,
  type HistoryEntry,
} from '@core/commands/history';
import type { Patch } from '@core/commands/patch';
import { filesForPatch, type LoadIssue } from '@core/files/world-files';
import type { World } from '@core/model/world';
import type { CoreError } from '@core/util/result';
import type {
  DispatchResult,
  HistoryInfo,
  PatchEvent,
  SaveStatus,
  WorldSnapshot,
} from '@shared/ipc';
import { diskState } from './store/disk-state';
import { loadWorldDir, writeChanges } from './store/world-dir';

type Listener<T> = (value: T) => void;

/**
 * Work outside the world's files that belongs to one undo step (an export's
 * spec file): run on the save queue after the step is undone or redone.
 */
export interface StepEffect {
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/**
 * The world in the main process: the single source of truth. Applies commands
 * (pure, from src/core), records undo history, persists only the touched files
 * (serially, atomically) and notifies listeners with numbered patches.
 */
export class WorldSession {
  private history: History = emptyHistory();
  private rev = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private save: SaveStatus = { state: 'saved' };
  private readonly patchListeners = new Set<Listener<PatchEvent>>();
  private readonly saveListeners = new Set<Listener<SaveStatus>>();
  private readonly effects = new WeakMap<HistoryEntry, StepEffect>();

  private constructor(
    readonly dir: string,
    private current: World,
    private issues: LoadIssue[],
    private readonly clock: () => string,
  ) {}

  static async open(
    dir: string,
    clock: () => string = () => new Date().toISOString(),
  ): Promise<WorldSession> {
    const { world, issues } = await loadWorldDir(dir);
    return new WorldSession(dir, world, issues, clock);
  }

  get world(): World {
    return this.current;
  }

  snapshot(): WorldSnapshot {
    return {
      rev: this.rev,
      dir: this.dir,
      world: this.current,
      issues: this.issues,
      history: this.historyInfo(),
    };
  }

  saveStatus(): SaveStatus {
    return this.save;
  }

  onPatch(l: Listener<PatchEvent>): () => void {
    this.patchListeners.add(l);
    return () => this.patchListeners.delete(l);
  }

  onSaveStatus(l: Listener<SaveStatus>): () => void {
    this.saveListeners.add(l);
    return () => this.saveListeners.delete(l);
  }

  /** Applies commands as one undoable step. */
  dispatch(
    commands: readonly { type: string; payload: unknown }[],
    label?: string,
    effect?: StepEffect,
  ): DispatchResult {
    const r = applyCommands(this.current, commands, { now: this.clock() });
    if (!r.ok) return { ok: false, error: r.error };
    if (r.value.patch.length === 0) return { ok: true, rev: this.rev };
    const name = label ?? labelOf(this.current, commands);
    this.history = record(this.history, {
      label: name,
      patch: r.value.patch,
      inverse: r.value.inverse,
    });
    const entry = this.history.past[this.history.past.length - 1];
    if (effect && entry) this.effects.set(entry, effect);
    this.commit(r.value.world, r.value.patch, 'command', name);
    return { ok: true, rev: this.rev };
  }

  undo(): { ok: true; rev: number; label?: string } | { ok: false; error: CoreError } {
    return this.step(undo(this.current, this.history), 'undo');
  }

  redo(): { ok: true; rev: number; label?: string } | { ok: false; error: CoreError } {
    return this.step(redo(this.current, this.history), 'redo');
  }

  private step(
    r: ReturnType<typeof undo>,
    cause: 'undo' | 'redo',
  ): { ok: true; rev: number; label?: string } | { ok: false; error: CoreError } {
    if (r === null)
      return {
        ok: false,
        error: { code: `history.nothing_to_${cause}`, message: `nothing to ${cause}` },
      };
    if (!r.ok) return r;
    const before = this.history;
    const entry =
      cause === 'undo'
        ? before.past[before.past.length - 1]
        : before.future[before.future.length - 1];
    this.history = r.value.history;
    this.commit(r.value.world, r.value.patch, cause, r.value.label);
    const effect = entry ? this.effects.get(entry) : undefined;
    if (effect) this.persist(() => (cause === 'undo' ? effect.undo() : effect.redo()));
    return { ok: true, rev: this.rev, label: r.value.label };
  }

  /**
   * Replaces the world after a change made outside carbon (a hand edit, Claude
   * Code, a git checkout). Nothing is written back to disk; the renderer gets a
   * patch with cause `external`. Undo history is cleared, because its inverses
   * were computed against the old files. (For package W6's file watcher.)
   */
  applyExternal(next: World, issues: LoadIssue[] = this.issues): void {
    this.issues = issues;
    const patch = diffWorlds(this.current, next);
    if (patch.length === 0) return;
    this.history = emptyHistory(this.history.limit);
    this.current = next;
    this.rev++;
    const event: PatchEvent = {
      rev: this.rev,
      patch,
      cause: 'external',
      label: 'Changed outside carbon',
      history: this.historyInfo(),
    };
    for (const l of this.patchListeners) l(event);
  }

  private historyInfo(): HistoryInfo {
    const u = this.history.past[this.history.past.length - 1];
    const d = this.history.future[this.history.future.length - 1];
    return {
      canUndo: !!u,
      canRedo: !!d,
      ...(u ? { undoLabel: u.label } : {}),
      ...(d ? { redoLabel: d.label } : {}),
    };
  }

  private commit(next: World, patch: Patch, cause: PatchEvent['cause'], label: string): void {
    const before = this.current;
    this.current = next;
    this.rev++;
    const changes = filesForPatch(before, next, patch);
    this.persist(() => writeChanges(this.dir, changes));
    const event: PatchEvent = { rev: this.rev, patch, cause, label, history: this.historyInfo() };
    for (const l of this.patchListeners) l(event);
  }

  private persist(task: () => Promise<void>): void {
    this.setSave({ state: 'saving', ...(this.save.at ? { at: this.save.at } : {}) });
    this.saveQueue = this.saveQueue.then(task).then(
      () => this.setSave({ state: 'saved', at: this.clock() }),
      (e: unknown) =>
        this.setSave({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  }

  private setSave(s: SaveStatus): void {
    this.save = s;
    for (const l of this.saveListeners) l(s);
  }

  /** Whether some file failed to save and is waiting for a retry (store/disk-state.ts). */
  hasUnsaved(): boolean {
    return diskState(this.dir).unsaved.size > 0;
  }

  /** Retries the files whose last write failed, without a new command. */
  retrySave(): void {
    if (!this.hasUnsaved()) return;
    this.persist(() => writeChanges(this.dir, { write: new Map(), remove: [] }));
  }

  /** Resolves when every pending write has finished. */
  async flush(): Promise<void> {
    await this.saveQueue;
  }
}
